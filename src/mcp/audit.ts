/**
 * The audit log (#12).
 *
 * This is the control that makes the write tools defensible rather than the
 * paperwork around them. Every body in this mailbox is attacker-controlled text
 * sitting one tool call away from a write, and no amount of prompting makes
 * that not so — what makes it survivable is that anything a smuggled
 * instruction achieves is a row here, and the rows are a list you can look at.
 *
 * Written from the tool layer rather than from the mailbox layer, because this
 * is the only side that knows two of the columns: the Access identity of the
 * caller, and the arguments as the model actually supplied them. It also means
 * an attempt refused before the mailbox is ever contacted — a message id that
 * is not in the index — is recorded, and that is the shape an injected
 * instruction most often leaves behind.
 *
 * Two statements rather than one, and that is the point of the design:
 *
 *   1. The intent is recorded BEFORE the write is attempted, as an error.
 *   2. The outcome is written over it afterwards.
 *
 * So a worker that dies mid-write leaves a row saying a write was attempted and
 * never reported back, which is the truthful conservative reading. Recording
 * afterwards only would have left nothing at all — and would have tripped over
 * write_log.message_id being a real foreign key, since a successful move
 * deletes the row it points at.
 */

import type { WriteOutcome } from "../writes";

/** What is known before the write is attempted. */
export type WriteAttempt = {
  /** flag_message, move_message, create_draft. */
  tool: string;
  /** The Access identity of the caller, or null if it could not be read. */
  actor: string | null;
  /** The message being acted on, when the tool names one and it resolved. */
  target?: { messageId: number; folder: string; uidValidity: number; uid: number };
  /** The tool arguments, as the model supplied them. */
  args: unknown;
};

const PENDING = "no outcome recorded — the write did not report back";

export async function recordAttempt(db: D1Database, attempt: WriteAttempt): Promise<number> {
  // `last_row_id` rather than a RETURNING clause, so there is no "the insert
  // succeeded but gave back no row" case to have an opinion about. A write that
  // cannot be recorded must not happen, and the way to guarantee that is for
  // this statement to either throw or produce an id.
  const { meta } = await db
    .prepare(
      `INSERT INTO write_log (tool, actor, message_id, folder, uidvalidity, uid,
                              arguments, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)`,
    )
    .bind(
      attempt.tool,
      attempt.actor,
      attempt.target?.messageId ?? null,
      attempt.target?.folder ?? null,
      attempt.target?.uidValidity ?? null,
      attempt.target?.uid ?? null,
      JSON.stringify(attempt.args ?? null),
      PENDING,
    )
    .run();

  return meta.last_row_id;
}

export async function recordOutcome(
  db: D1Database,
  id: number,
  outcome: WriteOutcome,
): Promise<void> {
  await db
    .prepare("UPDATE write_log SET outcome = ?, detail = ? WHERE id = ?")
    .bind(outcome.ok ? "ok" : "error", outcome.ok ? outcome.detail : outcome.reason, id)
    .run();
}
