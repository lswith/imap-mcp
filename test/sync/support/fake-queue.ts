/**
 * A queue binding that records what enumeration posted to it.
 *
 * The real binding is exercised through the exported `queue()` handler with
 * `createMessageBatch` (test/handlers.test.ts). This is the producer half: what
 * matters about enumeration is the shape of the messages it sends and how many
 * of them, which is easier to read off a recorder than out of a live queue.
 */

import type { ChunkProducer, SyncChunk } from "../../../src/sync/queue";

export class FakeQueue implements ChunkProducer {
  /** Every sendBatch call, as it was made — batch boundaries included. */
  readonly batches: SyncChunk[][] = [];

  /** Everything sent, flattened. */
  get sent(): SyncChunk[] {
    return this.batches.flat();
  }

  async send(body: SyncChunk): Promise<void> {
    this.batches.push([body]);
  }

  async sendBatch(messages: Iterable<MessageSendRequest<SyncChunk>>): Promise<void> {
    this.batches.push([...messages].map((message) => message.body));
  }
}
