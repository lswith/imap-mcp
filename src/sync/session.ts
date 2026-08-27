/**
 * The connection both entry points share.
 *
 * `connect` is a seam for tests, which drive a fake Mailbox. The real protocol
 * is covered where it belongs — test/imap/protocol runs the genuine cf-imap client
 * against a scripted IMAP server — and that harness aliases
 * `cloudflare:sockets`, which cannot be done inside workerd, where these tests
 * have to run to reach D1.
 */

import { connectMailbox, type Mailbox, type MailboxConfig } from "../imap";
import type { SyncConfig } from "./config";
import { describeError, type Logger } from "./log";

export type SyncDeps = {
  connect?: (config: SyncConfig) => Promise<Mailbox>;
  log?: Logger;
};

/**
 * The connection options, separated from opening the connection.
 *
 * Only so `enable` is assertable: every other test in this package injects
 * `deps.connect` and never reaches defaultConnect, and a missing ENABLE is the
 * kind of mistake that produces no error at all.
 */
export function mailboxConfig(config: SyncConfig): MailboxConfig {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    // CONDSTORE, session-wide (#8). RFC 5161 requires ENABLE in the
    // authenticated state, and connectMailbox issues this between
    // authentication and returning a Mailbox — so it cannot be issued too
    // late. Whether it took effect is read off HIGHESTMODSEQ per folder, never
    // off the ENABLE reply, which iCloud returns empty while plainly having
    // enabled it.
    enable: ["CONDSTORE"],
  };
}

function defaultConnect(config: SyncConfig): Promise<Mailbox> {
  return connectMailbox(mailboxConfig(config));
}

/**
 * One connection, closed however the body ends.
 *
 * The close is guarded because a failure closing must not replace the error
 * that is on its way out of here.
 */
export async function withMailbox<T>(
  config: SyncConfig,
  deps: SyncDeps,
  log: Logger,
  body: (mailbox: Mailbox) => Promise<T>,
): Promise<T> {
  const mailbox = await (deps.connect ?? defaultConnect)(config);
  try {
    return await body(mailbox);
  } finally {
    try {
      await mailbox.close();
    } catch (error) {
      log.warn(`closing the mailbox failed: ${describeError(error)}`);
    }
  }
}
