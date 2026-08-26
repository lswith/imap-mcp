/**
 * A stand-in for the sync worker, on the other end of the service binding.
 *
 * Records the request rather than performing it: what this package is
 * responsible for is resolving a message id into uid coordinates, writing the
 * audit row, and framing the answer. What the mailbox does with the request is
 * packages/sync's, and is tested there against a mailbox that behaves like one.
 */

import type {
  DraftRequest,
  FlagRequest,
  MoveRequest,
  WriteOutcome,
  WriteService,
} from "@imap-mcp/writes";

export class FakeWriter implements WriteService {
  readonly calls: Array<{ method: string; request: unknown }> = [];

  #outcome: WriteOutcome;
  #throws: Error | undefined;

  constructor(outcome: WriteOutcome = { ok: true, detail: "done" }, throws?: Error) {
    this.#outcome = outcome;
    this.#throws = throws;
  }

  async flagMessage(request: FlagRequest): Promise<WriteOutcome> {
    return this.#record("flagMessage", request);
  }

  async moveMessage(request: MoveRequest): Promise<WriteOutcome> {
    return this.#record("moveMessage", request);
  }

  async createDraft(request: DraftRequest): Promise<WriteOutcome> {
    return this.#record("createDraft", request);
  }

  #record(method: string, request: unknown): WriteOutcome {
    this.calls.push({ method, request });
    if (this.#throws) throw this.#throws;
    return this.#outcome;
  }
}

/** An env with the binding pointed at a fake, as the fetch handler would hand it over. */
export function envWithWriter(env: Env, writer: WriteService | undefined): Env {
  return { ...env, SYNC_WRITER: writer } as unknown as Env;
}
