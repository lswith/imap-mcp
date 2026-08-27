import { connectMailbox } from "../../../src/imap";
import type { Mailbox, MailboxConfig } from "../../../src/imap/types";
import { installServer } from "./fake-sockets";
import { FakeImapServer, type FakeServerOptions } from "./server";

/** The credential the protocol tests connect with. Never appears in output. */
export const TEST_PASSWORD = "correct-horse-battery-staple";

export function fakeServer(options: FakeServerOptions = {}): FakeImapServer {
  const server = new FakeImapServer(options);
  installServer(server);
  return server;
}

export async function openMailbox(
  options: FakeServerOptions = {},
  config: Partial<MailboxConfig> = {},
): Promise<{ server: FakeImapServer; mailbox: Mailbox }> {
  const server = fakeServer(options);
  const mailbox = await connectMailbox({
    host: "imap.example.invalid",
    port: 993,
    username: "ada",
    password: TEST_PASSWORD,
    timeoutMs: 2000,
    ...config,
  });
  return { server, mailbox };
}
