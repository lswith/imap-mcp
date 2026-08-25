/**
 * A Mailbox that answers from memory, and records what was asked of it.
 *
 * The real protocol is exercised in packages/imap, where the genuine cf-imap
 * client runs against a scripted IMAP server. That harness aliases
 * `cloudflare:sockets`, which is a runtime built-in inside workerd rather than
 * something a bundler resolves — so it cannot be used here, and here is where
 * the tests have to run to reach D1. This stands in for it.
 *
 * It holds several folders, because enumeration (#6) walks a list of them over
 * one connection and a consumer selects whichever folder its chunk names.
 *
 * Every mutating method throws. An indexing run that marked mail as read, or
 * moved it, or deleted it, should fail a test rather than change a mailbox.
 */

import type {
  FetchOptions,
  FolderState,
  Mailbox,
  MailboxAttachment,
  MailboxFolder,
  MailboxMessage,
  SearchCriteria,
  UidSet,
} from "@imap-mcp/imap";

type FakeFolder = {
  name?: string;
  uidValidity?: number;
  uidNext?: number;
  highestModSeq?: number;
  messages?: MailboxMessage[];
};

/** One folder, or several. `messages` alone means a single folder named Archive. */
export type FakeMailboxOptions = FakeFolder & { folders?: FakeFolder[] };

type Folder = Required<Omit<FakeFolder, "uidNext" | "highestModSeq">> & {
  uidNext?: number;
  highestModSeq?: number;
};

export class FakeMailbox implements Mailbox {
  readonly capabilities = ["IMAP4rev1", "UIDPLUS", "CONDSTORE"];

  /** Everything the worker asked for, in order. */
  readonly selects: Array<{ name: string; readOnly: boolean }> = [];
  /** The whole criteria object, so a test can assert what was NOT sent. */
  readonly searches: SearchCriteria[] = [];
  readonly fetches: FetchOptions[] = [];
  closed = false;

  #folders: Folder[];
  #selected: Folder | undefined;

  constructor(options: FakeMailboxOptions = {}) {
    const declared = options.folders ?? [options];
    this.#folders = declared.map((folder) => ({
      name: folder.name ?? "Archive",
      uidValidity: folder.uidValidity ?? 100,
      uidNext: folder.uidNext,
      highestModSeq: folder.highestModSeq,
      messages: folder.messages ?? [],
    }));
  }

  /** Replaces a folder's contents, as a re-sync of changed mail would see. */
  setMessages(messages: MailboxMessage[], name = "Archive"): void {
    this.#folder(name).messages = messages;
  }

  /** Renumbers a folder, the way a server-side restore does. */
  setUidValidity(uidValidity: number, name = "Archive"): void {
    this.#folder(name).uidValidity = uidValidity;
  }

  async listFolders(): Promise<MailboxFolder[]> {
    return this.#folders.map((folder) => ({
      name: folder.name,
      delimiter: "/",
      attributes: ["HasNoChildren"],
    }));
  }

  async selectFolder(name: string, options: { readOnly?: boolean } = {}): Promise<FolderState> {
    this.selects.push({ name, readOnly: options.readOnly === true });
    const folder = this.#folder(name);
    this.#selected = folder;
    return {
      name,
      exists: folder.messages.length,
      recent: 0,
      uidNext: folder.uidNext ?? highestUid(folder) + 1,
      uidValidity: folder.uidValidity,
      highestModSeq: folder.highestModSeq,
      noModSeq: folder.highestModSeq === undefined,
      flags: ["Seen", "Flagged"],
      permanentFlags: ["Seen", "Flagged"],
      readOnly: options.readOnly === true,
    };
  }

  async status(name: string): Promise<Record<string, number>> {
    const folder = this.#folder(name);
    return { MESSAGES: folder.messages.length, UIDVALIDITY: folder.uidValidity };
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    this.searches.push(criteria);
    const range = criteria.uids;
    let matches = this.#current().messages;

    if (range && typeof range === "object" && !Array.isArray(range)) {
      const to = range.to === "*" ? Number.POSITIVE_INFINITY : range.to;
      matches = matches.filter((message) => message.uid >= range.from && message.uid <= to);
    }
    if (criteria.since) {
      const since = criteria.since.getTime();
      matches = matches.filter((message) => message.internalDate.getTime() >= since);
    }
    return matches.map((message) => message.uid);
  }

  async fetchMessages(options: FetchOptions): Promise<MailboxMessage[]> {
    this.fetches.push(options);
    const wanted = new Set(uidsOf(options.uids));
    return this.#current().messages.filter((message) => wanted.has(message.uid));
  }

  async setFlags(): Promise<never> {
    throw new Error("setFlags: indexing must never write to the mailbox");
  }

  async copy(): Promise<never> {
    throw new Error("copy: indexing must never write to the mailbox");
  }

  async expunge(): Promise<never> {
    throw new Error("expunge: indexing must never write to the mailbox");
  }

  async append(): Promise<never> {
    throw new Error("append: indexing must never write to the mailbox");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  #folder(name: string): Folder {
    const folder = this.#folders.find((candidate) => candidate.name === name);
    if (!folder) throw new Error(`No such folder: ${name}`);
    return folder;
  }

  #current(): Folder {
    if (!this.#selected) throw new Error("No folder is selected");
    return this.#selected;
  }
}

function highestUid(folder: Folder): number {
  return folder.messages.reduce((highest, message) => Math.max(highest, message.uid), 0);
}

function uidsOf(uids: UidSet): number[] {
  if (typeof uids === "number") return [uids];
  if (Array.isArray(uids)) return uids;
  const to = uids.to === "*" ? uids.from + 1000 : uids.to;
  const out: number[] = [];
  for (let uid = uids.from; uid <= to; uid++) out.push(uid);
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_DATE = new Date("2026-08-20T09:00:00.000Z");

export function fakeMessage(uid: number, overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  // Replaced wholesale rather than merged, so a test can say "this message has
  // no Date header at all" — which plenty of real mail does.
  const headers = overrides.headers ?? { date: DEFAULT_DATE.toUTCString() };
  return {
    uid,
    seq: uid,
    flags: [],
    internalDate: DEFAULT_DATE,
    size: 1024,
    from: ["Ada Lovelace <ada@example.invalid>"],
    to: ["bob@example.invalid"],
    cc: [],
    subject: `Message ${uid}`,
    messageId: `<${uid}@example.invalid>`,
    contentType: "text/plain; charset=utf-8",
    rawHeaders: "",
    raw: "",
    attachments: [],
    ...overrides,
    headers,
  };
}

export function fakeAttachment(overrides: Partial<MailboxAttachment> = {}): MailboxAttachment {
  return {
    filename: "notes.txt",
    mimeType: "text/plain",
    size: 12,
    encoding: "base64",
    contentBase64: "aGVsbG8gd29ybGQK",
    isInline: false,
    ...overrides,
  };
}
