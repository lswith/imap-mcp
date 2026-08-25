/**
 * A Mailbox that answers from memory, and records what was asked of it.
 *
 * The real protocol is exercised in packages/imap, where the genuine cf-imap
 * client runs against a scripted IMAP server. That harness aliases
 * `cloudflare:sockets`, which is a runtime built-in inside workerd rather than
 * something a bundler resolves — so it cannot be used here, and here is where
 * the tests have to run to reach D1. This stands in for it.
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
import { formatUidSet } from "@imap-mcp/imap";

export type FakeFolderOptions = {
  name?: string;
  uidValidity?: number;
  uidNext?: number;
  highestModSeq?: number;
  messages?: MailboxMessage[];
};

export class FakeMailbox implements Mailbox {
  readonly capabilities = ["IMAP4rev1", "UIDPLUS", "CONDSTORE"];

  /** Everything the sync worker asked for, in order. */
  readonly selects: Array<{ name: string; readOnly: boolean }> = [];
  readonly searches: string[] = [];
  readonly fetches: FetchOptions[] = [];
  closed = false;

  #name: string;
  #uidValidity: number;
  #uidNext?: number;
  #highestModSeq?: number;
  #messages: MailboxMessage[];

  constructor(options: FakeFolderOptions = {}) {
    this.#name = options.name ?? "Archive";
    this.#uidValidity = options.uidValidity ?? 100;
    this.#uidNext = options.uidNext;
    this.#highestModSeq = options.highestModSeq;
    this.#messages = options.messages ?? [];
  }

  /** Replaces the folder's contents, as a re-sync of changed mail would see. */
  setMessages(messages: MailboxMessage[]): void {
    this.#messages = messages;
  }

  async listFolders(): Promise<MailboxFolder[]> {
    return [{ name: this.#name, delimiter: "/", attributes: ["HasNoChildren"] }];
  }

  async selectFolder(name: string, options: { readOnly?: boolean } = {}): Promise<FolderState> {
    this.selects.push({ name, readOnly: options.readOnly === true });
    if (name !== this.#name) throw new Error(`No such folder: ${name}`);
    return {
      name,
      exists: this.#messages.length,
      recent: 0,
      uidNext: this.#uidNext ?? this.#highestUid() + 1,
      uidValidity: this.#uidValidity,
      highestModSeq: this.#highestModSeq,
      noModSeq: this.#highestModSeq === undefined,
      flags: ["Seen", "Flagged"],
      permanentFlags: ["Seen", "Flagged"],
      readOnly: options.readOnly === true,
    };
  }

  async status(): Promise<Record<string, number>> {
    return { MESSAGES: this.#messages.length, UIDVALIDITY: this.#uidValidity };
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    this.searches.push(criteria.uids ? formatUidSet(criteria.uids) : "ALL");
    const range = criteria.uids;
    if (!range || typeof range !== "object" || Array.isArray(range)) {
      return this.#messages.map((message) => message.uid);
    }
    const to = range.to === "*" ? Number.POSITIVE_INFINITY : range.to;
    return this.#messages
      .filter((message) => message.uid >= range.from && message.uid <= to)
      .map((message) => message.uid);
  }

  async fetchMessages(options: FetchOptions): Promise<MailboxMessage[]> {
    this.fetches.push(options);
    const wanted = new Set(uidsOf(options.uids));
    return this.#messages.filter((message) => wanted.has(message.uid));
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

  #highestUid(): number {
    return this.#messages.reduce((highest, message) => Math.max(highest, message.uid), 0);
  }
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
