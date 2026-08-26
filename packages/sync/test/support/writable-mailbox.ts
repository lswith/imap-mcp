/**
 * A Mailbox that accepts writes, and records them in the order they happened.
 *
 * Separate from FakeMailbox rather than an option on it. FakeMailbox throws
 * from every mutating method, and that is not laziness — it is what proves an
 * indexing run cannot mark mail as read, move it or delete it, and
 * consume.test.ts asserts exactly that by reaching lines it would otherwise
 * throw on. Adding a "writes allowed" flag would put that guarantee one
 * argument away from being switched off.
 *
 * `writes` is one flat list rather than a call count per method because the
 * order is the thing under test: a move is COPY, then STORE \Deleted, then UID
 * EXPUNGE, and doing those in any other order is how a message gets deleted
 * without having been copied anywhere.
 */

import type {
  AppendedMessage,
  AppendOptions,
  CopyResult,
  FetchOptions,
  FlagMode,
  FolderState,
  Mailbox,
  MailboxFolder,
  MailboxMessage,
  MessageFlags,
  UidSet,
} from "@imap-mcp/imap";

type FakeMessage = { uid: number; flags: string[] };

type FakeFolder = {
  name: string;
  delimiter?: string;
  attributes?: string[];
  uidValidity?: number;
  messages?: FakeMessage[];
};

export type WritableMailboxOptions = {
  folders?: FakeFolder[];
  /**
   * The server answered the COPY without a COPYUID response code. Real, and
   * the case that must stop a move dead: without it nothing has confirmed the
   * copy landed, and the next step marks the original \Deleted.
   */
  copyWithoutUid?: boolean;
  /** The server answered the APPEND without an APPENDUID response code. */
  appendWithoutUid?: boolean;
  /** Flags the server silently refuses to set, e.g. a read-only folder. */
  ignoreFlags?: string[];
  /**
   * Another mail client cleared \Deleted between the read-back and the
   * expunge, so UID EXPUNGE removes nothing and reports nothing.
   */
  deletedClearedBeforeExpunge?: boolean;
};

const DEFAULT_FOLDERS: FakeFolder[] = [
  { name: "Archive", uidValidity: 100, messages: [{ uid: 12, flags: [] }] },
  { name: "Saved", uidValidity: 200 },
  { name: "Trash", uidValidity: 300 },
  { name: "Drafts", uidValidity: 400, attributes: ["HasNoChildren", "Drafts"] },
];

export class WritableMailbox implements Mailbox {
  readonly capabilities = ["IMAP4rev1", "UIDPLUS", "CONDSTORE"];

  /** Every mutating call, in order, as a short line a test can match on. */
  readonly writes: string[] = [];
  readonly selects: Array<{ name: string; readOnly: boolean }> = [];
  /** The raw message body of the last append, for asserting on headers. */
  appended: string | undefined;
  closed = false;

  #folders: Required<FakeFolder>[];
  #selected: Required<FakeFolder> | undefined;
  #options: WritableMailboxOptions;
  #nextUid = 900;

  constructor(options: WritableMailboxOptions = {}) {
    this.#options = options;
    this.#folders = (options.folders ?? DEFAULT_FOLDERS).map((folder) => ({
      name: folder.name,
      delimiter: folder.delimiter ?? "/",
      attributes: folder.attributes ?? ["HasNoChildren"],
      uidValidity: folder.uidValidity ?? 100,
      // Copied, not referenced. These writes mutate, and DEFAULT_FOLDERS is a
      // module-level constant — sharing the arrays would leak one test's flags
      // into the next.
      messages: (folder.messages ?? []).map((message) => ({
        ...message,
        flags: [...message.flags],
      })),
    }));
  }

  async listFolders(): Promise<MailboxFolder[]> {
    return this.#folders.map((folder) => ({
      name: folder.name,
      delimiter: folder.delimiter,
      attributes: folder.attributes,
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
      uidNext: this.#nextUid,
      uidValidity: folder.uidValidity,
      highestModSeq: 4242,
      noModSeq: false,
      flags: ["Seen", "Flagged", "Answered", "Deleted"],
      permanentFlags: ["Seen", "Flagged", "Answered", "Deleted"],
      readOnly: options.readOnly === true,
    };
  }

  async status(name: string): Promise<Record<string, number>> {
    const folder = this.#folder(name);
    return { MESSAGES: folder.messages.length, UIDVALIDITY: folder.uidValidity };
  }

  async search(): Promise<number[]> {
    return this.#current().messages.map((message) => message.uid);
  }

  async fetchMessages(options: FetchOptions): Promise<MailboxMessage[]> {
    void options;
    return [];
  }

  async setFlags(uids: UidSet, flags: string[], mode: FlagMode = "add"): Promise<MessageFlags[]> {
    const uid = single(uids);
    this.writes.push(`setFlags ${uid} ${mode} ${flags.join(",")}`);

    const message = this.#current().messages.find((candidate) => candidate.uid === uid);
    if (!message) return [];

    const ignored = new Set(this.#options.ignoreFlags ?? []);
    const applied = flags.filter((flag) => !ignored.has(flag));
    if (mode === "replace") message.flags = [...applied];
    else if (mode === "add") message.flags = [...new Set([...message.flags, ...applied])];
    else message.flags = message.flags.filter((flag) => !applied.includes(flag));

    // The read-back, which is the only truthful answer under CONDSTORE.
    return [{ uid, flags: [...message.flags] }];
  }

  async copy(uids: UidSet, target: string): Promise<CopyResult | null> {
    const uid = single(uids);
    this.writes.push(`copy ${uid} -> ${target}`);

    const destination = this.#folder(target);
    const source = this.#current().messages.find((candidate) => candidate.uid === uid);
    if (!source) throw new Error(`No such uid: ${uid}`);

    const newUid = this.#nextUid++;
    destination.messages.push({ uid: newUid, flags: [...source.flags] });
    if (this.#options.copyWithoutUid) return null;
    return {
      uidValidity: destination.uidValidity,
      sourceUids: String(uid),
      destUids: String(newUid),
    };
  }

  async expunge(uids: UidSet): Promise<number[]> {
    const uid = single(uids);
    this.writes.push(`expunge ${uid}`);

    const folder = this.#current();
    if (this.#options.deletedClearedBeforeExpunge) {
      for (const message of folder.messages) {
        message.flags = message.flags.filter((flag) => flag !== "Deleted");
      }
    }
    const message = folder.messages.find((candidate) => candidate.uid === uid);
    // Same rule the real server follows: UID EXPUNGE only removes what is
    // actually marked \Deleted.
    if (!message?.flags.includes("Deleted")) return [];
    folder.messages = folder.messages.filter((candidate) => candidate.uid !== uid);
    return [uid];
  }

  async append(
    folder: string,
    message: string | Uint8Array,
    options: AppendOptions = {},
  ): Promise<AppendedMessage | null> {
    this.writes.push(`append ${folder} (${(options.flags ?? []).join(",")})`);
    this.appended = typeof message === "string" ? message : new TextDecoder().decode(message);

    const destination = this.#folder(folder);
    const uid = this.#nextUid++;
    destination.messages.push({ uid, flags: [...(options.flags ?? [])] });
    if (this.#options.appendWithoutUid) return null;
    return { uidValidity: destination.uidValidity, uid };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** The uids a folder currently holds, for asserting a move actually moved. */
  uidsIn(name: string): number[] {
    return this.#folder(name).messages.map((message) => message.uid);
  }

  #folder(name: string): Required<FakeFolder> {
    const folder = this.#folders.find((candidate) => candidate.name === name);
    if (!folder) throw new Error(`No such folder: ${name}`);
    return folder;
  }

  #current(): Required<FakeFolder> {
    if (!this.#selected) throw new Error("No folder is selected");
    return this.#selected;
  }
}

function single(uids: UidSet): number {
  if (typeof uids === "number") return uids;
  if (Array.isArray(uids)) {
    if (uids.length !== 1) throw new Error("A write must name exactly one uid");
    return uids[0] as number;
  }
  throw new Error("A write must name exactly one uid, not a range");
}
