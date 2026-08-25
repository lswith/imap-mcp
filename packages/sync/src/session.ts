/**
 * The connection both entry points share.
 *
 * `connect` is a seam for tests, which drive a fake Mailbox. The real protocol
 * is covered where it belongs — packages/imap runs the genuine cf-imap client
 * against a scripted IMAP server — and that harness aliases
 * `cloudflare:sockets`, which cannot be done inside workerd, where these tests
 * have to run to reach D1.
 */

import { connectMailbox, type Mailbox } from "@imap-mcp/imap";
import type { SyncConfig } from "./config";
import { describeError, type Logger } from "./log";

export type SyncDeps = {
  connect?: (config: SyncConfig) => Promise<Mailbox>;
  log?: Logger;
};

function defaultConnect(config: SyncConfig): Promise<Mailbox> {
  return connectMailbox({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    // No `enable: ["CONDSTORE"]`: nothing in this slice reads a mod-sequence,
    // and ENABLE is connection configuration that #8 will want set here when
    // it does.
  });
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
