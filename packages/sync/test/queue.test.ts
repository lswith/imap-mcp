import { describe, expect, it } from "vitest";
import {
  bucketOf,
  bucketRange,
  describeChunk,
  MalformedChunkError,
  parseChunk,
  type SyncChunk,
} from "../src/queue";

// The bucket arithmetic has to agree with the SQL in store.ts, and the parser
// is the only thing standing between a delivered body and a fetch loop acting
// on it.

function chunk(overrides: Partial<SyncChunk> = {}): SyncChunk {
  return {
    v: 1,
    folder: "Archive",
    folderId: 3,
    uidValidity: 100,
    from: 101,
    to: 200,
    uids: [101, 150],
    ...overrides,
  };
}

describe("uid buckets", () => {
  it("counts from uid 1, so a bucket is the same range on every run", () => {
    expect(bucketOf(1, 100)).toBe(0);
    expect(bucketOf(100, 100)).toBe(0);
    expect(bucketOf(101, 100)).toBe(1);
    expect(bucketRange(0, 100)).toEqual({ from: 1, to: 100 });
    expect(bucketRange(7, 100)).toEqual({ from: 701, to: 800 });
  });

  it("agrees with the integer division the gap-detection query does", () => {
    // (uid - 1) / size, floored — the same expression store.ts sends to SQLite.
    for (const uid of [1, 2, 99, 100, 101, 999, 1000, 1001]) {
      expect(bucketOf(uid, 100)).toBe(Math.floor((uid - 1) / 100));
    }
  });
});

describe("parsing a delivered body", () => {
  it("accepts what enumeration sends", () => {
    expect(parseChunk(chunk())).toEqual(chunk());
  });

  it("rejects anything it could not act on, naming what is wrong", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["not an object", /body is not an object/],
      [null, /body is not an object/],
      [{ ...chunk(), v: 2 }, /unsupported version 2/],
      [{ ...chunk(), v: undefined }, /unsupported version undefined/],
      [{ ...chunk(), folder: "" }, /folder is missing/],
      [{ ...chunk(), folder: 7 }, /folder is missing/],
      [{ ...chunk(), folderId: "3" }, /folderId or uidValidity is missing/],
      [{ ...chunk(), uidValidity: undefined }, /folderId or uidValidity is missing/],
      [{ ...chunk(), from: 1.5 }, /uid range is missing/],
      [{ ...chunk(), to: undefined }, /uid range is missing/],
      [{ ...chunk(), uids: "101" }, /uids is not a list of integers/],
      [{ ...chunk(), uids: [101, "150"] }, /uids is not a list of integers/],
    ];

    for (const [body, message] of cases) {
      expect(() => parseChunk(body)).toThrow(MalformedChunkError);
      expect(() => parseChunk(body)).toThrow(message);
    }
  });

  it("accepts an empty uid list — a range can legitimately hold nothing", () => {
    expect(parseChunk(chunk({ uids: [] })).uids).toEqual([]);
  });
});

describe("describeChunk", () => {
  it("says what was missed without saying what was in it", () => {
    expect(describeChunk(chunk())).toBe("Archive uids 101:200 (uidvalidity 100, 2 messages)");
  });
});
