/**
 * Stands in for the `cloudflare:sockets` built-in.
 *
 * vitest.config.ts aliases the module specifier to this file for the protocol
 * tests, which is what lets them drive the real cf-imap client against the
 * scripted server in server.ts. Nothing in src/ imports it.
 */

import type { FakeImapServer, FakeSocket } from "./server";

const queued: FakeImapServer[] = [];

/** Makes `server` answer the next connect() call. */
export function installServer(server: FakeImapServer): void {
  queued.push(server);
}

/** Drops any server that was installed but never connected to. */
export function resetServers(): void {
  queued.length = 0;
}

export function connect(
  _address: { hostname: string; port: number },
  _options?: unknown,
): FakeSocket {
  const server = queued.shift();
  if (!server) {
    throw new Error("No fake IMAP server installed — call installServer() before connecting.");
  }
  return server.attach();
}
