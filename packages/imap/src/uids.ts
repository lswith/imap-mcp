/**
 * UID set handling.
 *
 * Everything in this package addresses messages by UID, so this is where a
 * caller's UidSet becomes either an IMAP sequence-set string (for the commands
 * that take one) or a list of contiguous ranges (for FETCH, which takes one
 * range at a time).
 */

import type { UidRange, UidSet } from "./types";

/** UIDs are 32-bit unsigned (RFC 9051 §2.3.1.1), so this is what "*" means. */
export const MAX_UID = 4294967295;

function assertUid(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_UID) {
    throw new RangeError(`Not a valid IMAP UID: ${value}`);
  }
  return value;
}

function isRange(set: UidSet): set is UidRange {
  return typeof set === "object" && !Array.isArray(set);
}

/**
 * Collapses a UID set into ascending contiguous runs.
 *
 * FETCH takes a single range, so a sparse set is fetched as one command per
 * run rather than as one command spanning the gaps — [3, 4, 900] is two small
 * fetches, not one fetch of 898 messages.
 */
export function toUidRuns(set: UidSet): Array<{ from: number; to: number }> {
  if (typeof set === "number") {
    assertUid(set);
    return [{ from: set, to: set }];
  }

  if (isRange(set)) {
    const from = assertUid(set.from);
    const to = set.to === "*" ? MAX_UID : assertUid(set.to);
    if (to < from) throw new RangeError(`UID range ends before it starts: ${from}:${set.to}`);
    return [{ from, to }];
  }

  if (set.length === 0) throw new RangeError("UID set is empty");

  const sorted = [...new Set(set.map(assertUid))].sort((a, b) => a - b);
  const runs: Array<{ from: number; to: number }> = [];
  for (const uid of sorted) {
    const last = runs.at(-1);
    if (last && uid === last.to + 1) last.to = uid;
    else runs.push({ from: uid, to: uid });
  }
  return runs;
}

/** Formats a UID set as an IMAP sequence set, e.g. "1:3,7" or "42:*". */
export function formatUidSet(set: UidSet): string {
  if (typeof set === "number") return String(assertUid(set));

  if (isRange(set)) {
    const from = assertUid(set.from);
    if (set.to === "*") return `${from}:*`;
    const to = assertUid(set.to);
    if (to < from) throw new RangeError(`UID range ends before it starts: ${from}:${to}`);
    return from === to ? String(from) : `${from}:${to}`;
  }

  return toUidRuns(set)
    .map((run) => (run.from === run.to ? String(run.from) : `${run.from}:${run.to}`))
    .join(",");
}
