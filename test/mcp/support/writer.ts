/**
 * A stand-in for the write service, on the other side of the `WriteService`
 * seam.
 *
 * Records the request rather than performing it: what the tool layer is
 * responsible for is resolving a message id into uid coordinates, writing the
 * audit row, and framing the answer. What the mailbox does with the request is
 * the mailbox layer's (src/sync/writes.ts), and is tested in test/sync against
 * a mailbox that behaves like one.
 */

import type {
  DraftRequest,
  FlagRequest,
  MoveRequest,
  WriteOutcome,
  WriteService,
} from "../../../src/writes";

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
