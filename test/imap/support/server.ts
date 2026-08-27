/**
 * A scripted in-memory IMAP server.
 *
 * The point of it is to exercise the real cf-imap parser against
 * byte-for-byte protocol responses — literals, MIME bodies, CONDSTORE
 * MODSEQ, truncated streams — without a mailbox, a network or a live
 * credential. Every claim this repo makes about what the client does with a
 * given server response is pinned here rather than discovered in production.
 *
 * It implements only what this project sends: the commands in
 * ../../src/cf-imap-mailbox.ts, plus the handshake.
 */

export type FakeMessage = {
  uid: number;
  /** Flags without the leading backslash, e.g. ["Seen"]. */
  flags: string[];
  /** INTERNALDATE, e.g. "17-Jul-1996 02:44:25 -0700". */
  internalDate: string;
  /** The full RFC 5322 message, CRLF line endings. */
  raw: Uint8Array;
};

export type Command = {
  tag: string;
  /** Command name, upper-cased, e.g. "UID FETCH" for UID commands. */
  name: string;
  /** Everything after the command name. */
  args: string;
  /** The whole line as received. */
  raw: string;
};

export type Reply = Array<string | Uint8Array>;

export type FakeServerOptions = {
  capabilities?: string[];
  greeting?: string;
  /** Fail LOGIN with a tagged NO. */
  authFailure?: string;
  /** What ENABLE confirms. iCloud answers with an empty list — see #8. */
  enableReply?: string[];
  /**
   * Report HIGHESTMODSEQ on SELECT and append `MODSEQ (n)` to untagged FETCH,
   * as RFC 7162 §3.1.3 requires once CONDSTORE is enabled.
   */
  condstore?: boolean;
  highestModSeq?: number;
  uidValidity?: number;
  messages?: FakeMessage[];
  folders?: Array<{ name: string; delimiter: string; attributes: string[] }>;
  /** UIDs a UID SEARCH should return. */
  searchResult?: number[];
  /**
   * Escape hatch: answer a command yourself. Return null to fall through to
   * the default behaviour.
   */
  onCommand?: (command: Command, server: FakeImapServer) => Reply | null;
};

const DEFAULT_CAPABILITIES = [
  "IMAP4rev1",
  "UIDPLUS",
  "CONDSTORE",
  "QRESYNC",
  "NAMESPACE",
  "UNSELECT",
  "CHILDREN",
];

const encoder = new TextEncoder();

export function bytes(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A message with CRLF line endings, from lines written with plain newlines. */
export function message(text: string): Uint8Array {
  return encoder.encode(text.replace(/\r?\n/g, "\r\n"));
}

export class FakeImapServer {
  readonly options: FakeServerOptions;
  /** Every command line the client sent, in order. Assert against it. */
  readonly commands: string[] = [];

  #messages: FakeMessage[];
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #buffer: Uint8Array = new Uint8Array(0);
  #greeted = false;
  #pendingAppend: { tag: string; remaining: number } | null = null;
  #condstoreEnabled = false;

  constructor(options: FakeServerOptions = {}) {
    this.options = options;
    this.#messages = [...(options.messages ?? [])];
    // CONDSTORE only takes effect once the client has issued ENABLE — the
    // ordering RFC 5161 requires and #8 has to get right.
  }

  get messages(): readonly FakeMessage[] {
    return this.#messages;
  }

  /** Builds a socket, as `cloudflare:sockets`' connect() would. */
  attach(): FakeSocket {
    return new FakeSocket(this);
  }

  /** Closes the read side, as a server hanging up mid-response would. */
  disconnect(): void {
    this.#controller?.close();
    this.#controller = null;
  }

  /** Sends raw bytes to the client outside the request/response flow. */
  send(...parts: Array<string | Uint8Array>): void {
    this.#controller?.enqueue(bytes(...parts));
  }

  /** @internal — called by FakeSocket when a read stream is opened. */
  open(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    if (this.#greeted) return;
    this.#greeted = true;
    const capabilities = this.options.capabilities ?? DEFAULT_CAPABILITIES;
    this.send(this.options.greeting ?? `* OK [CAPABILITY ${capabilities.join(" ")}] ready\r\n`);
  }

  /** @internal — called by FakeSocket for every chunk the client writes. */
  receive(chunk: Uint8Array): void {
    this.#buffer = bytes(this.#buffer, chunk);

    for (;;) {
      if (this.#pendingAppend) {
        if (!this.#consumeAppendLiteral()) return;
        continue;
      }
      const line = this.#takeLine();
      if (line === null) return;
      this.#handleLine(line);
    }
  }

  #takeLine(): string | null {
    for (let i = 0; i < this.#buffer.length - 1; i++) {
      if (this.#buffer[i] === 13 && this.#buffer[i + 1] === 10) {
        const line = new TextDecoder().decode(this.#buffer.slice(0, i));
        this.#buffer = this.#buffer.slice(i + 2);
        return line;
      }
    }
    return null;
  }

  #consumeAppendLiteral(): boolean {
    const pending = this.#pendingAppend;
    if (!pending) return false;

    const take = Math.min(pending.remaining, this.#buffer.length);
    this.#buffer = this.#buffer.slice(take);
    pending.remaining -= take;
    if (pending.remaining > 0) return false;

    // The client follows the literal with a bare CRLF.
    if (this.#buffer.length < 2) return false;
    this.#buffer = this.#buffer.slice(2);
    this.#pendingAppend = null;

    const uid = this.#nextUid();
    this.send(`${pending.tag} OK [APPENDUID ${this.#uidValidity()} ${uid}] APPEND completed\r\n`);
    return true;
  }

  #handleLine(line: string): void {
    this.commands.push(line);

    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      this.send(`* BAD unparseable command\r\n`);
      return;
    }

    const tag = match[1];
    const rest = match[2];
    const uidPrefix = /^UID\s+(\S+)\s*(.*)$/i.exec(rest);
    const parsed = uidPrefix
      ? { name: `UID ${uidPrefix[1].toUpperCase()}`, args: uidPrefix[2] }
      : (() => {
          const bare = /^(\S+)\s*(.*)$/.exec(rest);
          return { name: (bare?.[1] ?? "").toUpperCase(), args: bare?.[2] ?? "" };
        })();

    const command: Command = { tag, name: parsed.name, args: parsed.args, raw: line };

    const scripted = this.options.onCommand?.(command, this);
    if (scripted) {
      this.send(...scripted);
      return;
    }

    this.send(...this.#respond(command));
  }

  #respond(command: Command): Reply {
    const { tag, name, args } = command;

    switch (name) {
      case "CAPABILITY":
        return [
          `* CAPABILITY ${(this.options.capabilities ?? DEFAULT_CAPABILITIES).join(" ")}\r\n`,
          `${tag} OK CAPABILITY completed\r\n`,
        ];

      case "LOGIN":
      case "AUTHENTICATE":
        if (this.options.authFailure) return [`${tag} NO ${this.options.authFailure}\r\n`];
        return [`${tag} OK ${name} completed\r\n`];

      case "ENABLE": {
        const requested = args.split(/\s+/).filter(Boolean);
        if (requested.some((capability) => capability.toUpperCase() === "CONDSTORE")) {
          this.#condstoreEnabled = this.options.condstore === true;
        }
        const confirmed = this.options.enableReply ?? requested;
        return [`* ENABLED ${confirmed.join(" ")}\r\n`, `${tag} OK ENABLE completed\r\n`];
      }

      case "LIST": {
        const folders = this.options.folders ?? [
          { name: "INBOX", delimiter: "/", attributes: ["HasNoChildren"] },
          { name: "Archive", delimiter: "/", attributes: ["HasNoChildren", "Archive"] },
        ];
        return [
          ...folders.map(
            (folder) =>
              `* LIST (${folder.attributes.map((a) => `\\${a}`).join(" ")}) "${folder.delimiter}" "${folder.name}"\r\n`,
          ),
          `${tag} OK LIST completed\r\n`,
        ];
      }

      case "SELECT":
      case "EXAMINE": {
        const lines = [
          `* ${this.#messages.length} EXISTS\r\n`,
          `* 0 RECENT\r\n`,
          `* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n`,
          `* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] limited\r\n`,
          `* OK [UIDVALIDITY ${this.#uidValidity()}] UIDs valid\r\n`,
          `* OK [UIDNEXT ${this.#nextUid()}] predicted next UID\r\n`,
        ];
        // HIGHESTMODSEQ appears only when CONDSTORE was enabled before this
        // SELECT — the exact behaviour #8 has to detect.
        if (this.#condstoreEnabled) {
          lines.push(`* OK [HIGHESTMODSEQ ${this.options.highestModSeq ?? 90210}] modseq\r\n`);
        }
        lines.push(
          `${tag} OK [${name === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${name} completed\r\n`,
        );
        return lines;
      }

      case "STATUS": {
        const folder = /^(?:"([^"]*)"|(\S+))/.exec(args);
        const name_ = folder?.[1] ?? folder?.[2] ?? "INBOX";
        return [
          `* STATUS "${name_}" (MESSAGES ${this.#messages.length} UIDNEXT ${this.#nextUid()} UIDVALIDITY ${this.#uidValidity()} UNSEEN ${this.#unseen()})\r\n`,
          `${tag} OK STATUS completed\r\n`,
        ];
      }

      case "UID FETCH": {
        const set = args.split(/\s+/)[0] ?? "";
        const wantsFullBody = /BODY(?:\.PEEK)?\[\]/i.test(args);
        const headerFields = /HEADER\.FIELDS \(([^)]*)\)/i.exec(args)?.[1] ?? null;
        const reply: Reply = [];
        for (const [index, msg] of this.#messages.entries()) {
          if (!inUidSet(set, msg.uid, this.#highestUid())) continue;
          reply.push(...this.#fetchItem(index + 1, msg, wantsFullBody, headerFields));
        }
        reply.push(`${tag} OK UID FETCH completed\r\n`);
        return reply;
      }

      case "UID STORE": {
        const parts = /^(\S+)\s+([+-]?)FLAGS(?:\.SILENT)?\s+\(([^)]*)\)/i.exec(args);
        if (!parts) return [`${tag} BAD unparseable STORE\r\n`];
        const [, set, operator, flagList] = parts;
        const flags = flagList
          .split(/\s+/)
          .filter(Boolean)
          .map((flag) => flag.replace(/^\\/, ""));

        const reply: Reply = [];
        for (const [index, msg] of this.#messages.entries()) {
          if (!inUidSet(set, msg.uid, this.#highestUid())) continue;
          if (operator === "+") msg.flags = [...new Set([...msg.flags, ...flags])];
          else if (operator === "-") msg.flags = msg.flags.filter((f) => !flags.includes(f));
          else msg.flags = [...flags];

          // The MODSEQ the client cannot parse. It is not optional: RFC 7162
          // §3.1.3 requires it on every untagged FETCH once CONDSTORE is on.
          const modseq = this.#condstoreEnabled
            ? ` MODSEQ (${(this.options.highestModSeq ?? 90210) + 1})`
            : "";
          reply.push(
            `* ${index + 1} FETCH (UID ${msg.uid} FLAGS (${renderFlags(msg.flags)})${modseq})\r\n`,
          );
        }
        reply.push(`${tag} OK UID STORE completed\r\n`);
        return reply;
      }

      case "UID EXPUNGE": {
        const set = args.split(/\s+/)[0] ?? "";
        const reply: Reply = [];
        for (let index = this.#messages.length - 1; index >= 0; index--) {
          const msg = this.#messages[index];
          if (!inUidSet(set, msg.uid, this.#highestUid())) continue;
          if (!msg.flags.includes("Deleted")) continue;
          this.#messages.splice(index, 1);
          reply.push(`* ${index + 1} EXPUNGE\r\n`);
        }
        reply.push(`${tag} OK UID EXPUNGE completed\r\n`);
        return reply;
      }

      case "UID COPY": {
        const parts = /^(\S+)\s+(.*)$/.exec(args);
        const set = parts?.[1] ?? "";
        const uids = this.#messages
          .filter((msg) => inUidSet(set, msg.uid, this.#highestUid()))
          .map((msg) => msg.uid);
        if (uids.length === 0) return [`${tag} NO no matching messages\r\n`];
        const destination = uids.map((_, offset) => this.#nextUid() + offset);
        return [
          `${tag} OK [COPYUID ${this.#uidValidity()} ${uids.join(",")} ${destination.join(",")}] COPY completed\r\n`,
        ];
      }

      case "APPEND": {
        const literal = /\{(\d+)\+?\}$/.exec(args);
        if (!literal) return [`${tag} BAD APPEND needs a literal\r\n`];
        this.#pendingAppend = { tag, remaining: Number(literal[1]) };
        return [`+ ready for literal\r\n`];
      }

      case "UID SEARCH":
        return [
          `* SEARCH ${(this.options.searchResult ?? []).join(" ")}\r\n`.replace(" \r\n", "\r\n"),
          `${tag} OK UID SEARCH completed\r\n`,
        ];

      case "NOOP":
        return [`${tag} OK NOOP completed\r\n`];

      case "CLOSE":
      case "UNSELECT":
        return [`${tag} OK ${name} completed\r\n`];

      case "LOGOUT":
        return [`* BYE logging out\r\n`, `${tag} OK LOGOUT completed\r\n`];

      default:
        return [`${tag} BAD unknown command ${name}\r\n`];
    }
  }

  #fetchItem(
    seq: number,
    msg: FakeMessage,
    wantsFullBody: boolean,
    headerFields: string | null,
  ): Reply {
    const modseq = this.#condstoreEnabled ? ` MODSEQ (${this.options.highestModSeq ?? 90210})` : "";
    // A real server echoes the requested section and returns only the fields
    // it names — mirrored here so a test can prove a header reached the
    // client only because the client asked for it.
    const section = wantsFullBody
      ? { label: "BODY[]", payload: msg.raw }
      : {
          label: `BODY[HEADER.FIELDS (${headerFields ?? ""})]`,
          payload: headerSection(msg.raw, headerFields),
        };

    return [
      `* ${seq} FETCH (UID ${msg.uid} FLAGS (${renderFlags(msg.flags)}) INTERNALDATE "${msg.internalDate}" RFC822.SIZE ${msg.raw.length}${modseq} ${section.label} {${section.payload.length}}\r\n`,
      section.payload,
      `)\r\n`,
    ];
  }

  #uidValidity(): number {
    return this.options.uidValidity ?? 4;
  }

  #highestUid(): number {
    return this.#messages.reduce((max, msg) => Math.max(max, msg.uid), 0);
  }

  #nextUid(): number {
    return this.#highestUid() + 1;
  }

  #unseen(): number {
    return this.#messages.filter((msg) => !msg.flags.includes("Seen")).length;
  }
}

function renderFlags(flags: string[]): string {
  return flags.map((flag) => `\\${flag}`).join(" ");
}

/** The header block of a raw message, terminated by its blank line. */
function headerSection(raw: Uint8Array, fields: string | null = null): Uint8Array {
  const text = new TextDecoder().decode(raw);
  const end = text.indexOf("\r\n\r\n");
  let header = end === -1 ? text : text.slice(0, end);

  if (fields !== null) {
    const wanted = new Set(
      fields
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((field) => field.toLowerCase()),
    );
    const kept: string[] = [];
    let keeping = false;
    for (const line of header.split("\r\n")) {
      // Folded continuation lines belong to the preceding field.
      if (/^[ \t]/.test(line)) {
        if (keeping) kept.push(line);
        continue;
      }
      const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
      keeping = wanted.has(name);
      if (keeping) kept.push(line);
    }
    header = kept.join("\r\n");
  }

  return encoder.encode(`${header}\r\n\r\n`);
}

/** Matches a UID against an IMAP sequence set: "5", "1:3", "1,4:*". */
function inUidSet(set: string, uid: number, highest: number): boolean {
  for (const part of set.split(",")) {
    if (!part) continue;
    if (!part.includes(":")) {
      if (Number(part) === uid) return true;
      continue;
    }
    const [rawFrom, rawTo] = part.split(":");
    const from = rawFrom === "*" ? highest : Number(rawFrom);
    const to = rawTo === "*" ? Math.max(highest, uid) : Number(rawTo);
    if (uid >= Math.min(from, to) && uid <= Math.max(from, to)) return true;
  }
  return false;
}

/** The client half of the connection: what cf-imap sees as a Socket. */
export class FakeSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  #server: FakeImapServer;

  constructor(server: FakeImapServer) {
    this.#server = server;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => server.open(controller),
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        server.receive(chunk);
      },
    });
  }

  /** STARTTLS upgrade: a fresh stream pair over the same server state. */
  startTls(): FakeSocket {
    return this.#server.attach();
  }

  async close(): Promise<void> {
    this.#server.disconnect();
  }
}
