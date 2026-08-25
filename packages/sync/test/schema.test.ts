import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The schema is applied by test/apply-migrations.ts before each test file,
// from the same SQL and the same wrangler splitter `wrangler d1 migrations
// apply` uses. What is asserted here is the behaviour the rest of the system
// is written against: the upsert key, the FTS index staying in step with the
// body column, and the delete semantics the audit log depends on.

const UPSERT_MESSAGE = `
  INSERT INTO messages (folder_id, uidvalidity, uid, rfc_message_id, subject,
                        from_address, internal_date, body_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (folder_id, uidvalidity, uid) DO UPDATE SET
    rfc_message_id = excluded.rfc_message_id,
    subject = excluded.subject,
    from_address = excluded.from_address,
    internal_date = excluded.internal_date,
    body_text = excluded.body_text
  RETURNING id`;

let folderId: number;

async function upsert(
  uid: number,
  subject: string,
  body: string,
  overrides: { folderId?: number; uidValidity?: number } = {},
): Promise<number> {
  const row = await env.DB.prepare(UPSERT_MESSAGE)
    .bind(
      overrides.folderId ?? folderId,
      overrides.uidValidity ?? 100,
      uid,
      `<${uid}@example.invalid>`,
      subject,
      "sender@example.invalid",
      1_700_000_000_000 + uid,
      body,
    )
    .first<{ id: number }>();
  return row!.id;
}

/** Message ids whose subject or body match an FTS query, best-ranked first. */
async function search(query: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?
     ORDER BY bm25(messages_fts, 10.0, 1.0)`,
  )
    .bind(query)
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  // Storage persists across tests in a file, so each one starts from a clean
  // mailbox. Deleting the folders cascades through messages, attachments and
  // the FTS index — which the cascade test below is what proves.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_log"),
    env.DB.prepare("DELETE FROM folders"),
  ]);

  const row = await env.DB.prepare(
    "INSERT INTO folders (name, uidvalidity) VALUES ('Archive', 100) RETURNING id",
  ).first<{ id: number }>();
  folderId = row!.id;
});

describe("migrations", () => {
  it("re-applying is a no-op", async () => {
    const before = await count("d1_migrations");

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    expect(before).toBeGreaterThan(0);
    expect(await count("d1_migrations")).toBe(before);
  });

  it("creates every table, index and trigger the rest of the system needs", async () => {
    const { results } = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND NOT (type = 'table' AND name LIKE 'messages_fts_%')`,
    ).all<{ type: string; name: string }>();
    const named = (type: string) =>
      results.filter((row) => row.type === type).map((row) => row.name);

    expect(named("table")).toEqual(
      expect.arrayContaining(["folders", "messages", "attachments", "write_log", "messages_fts"]),
    );
    expect(named("index")).toEqual(
      expect.arrayContaining([
        "messages_rfc_message_id",
        "messages_internal_date",
        "messages_from_address",
        "messages_folder_date",
        "attachments_message",
        "write_log_at",
      ]),
    );
    // If the migration splitter ever mangles a BEGIN...END body, this is where
    // it shows up — as a missing trigger rather than as silently stale search.
    expect(named("trigger")).toEqual(
      expect.arrayContaining(["messages_fts_insert", "messages_fts_delete", "messages_fts_update"]),
    );
  });
});

describe("the upsert key", () => {
  it("makes a re-run of the same fetch idempotent", async () => {
    const first = await upsert(7, "Original subject", "original body");
    const second = await upsert(7, "Corrected subject", "corrected body");

    expect(second).toBe(first);
    expect(await count("messages")).toBe(1);

    const row = await env.DB.prepare(
      "SELECT subject, body_text AS bodyText FROM messages WHERE id = ?",
    )
      .bind(first)
      .first<{ subject: string; bodyText: string }>();
    expect(row).toEqual({ subject: "Corrected subject", bodyText: "corrected body" });
  });

  it("rejects a duplicate that is not written as an upsert", async () => {
    await upsert(7, "Subject", "body");

    await expect(
      env.DB.prepare(
        `INSERT INTO messages (folder_id, uidvalidity, uid, subject, internal_date)
         VALUES (?, 100, 7, 'Duplicate', 1700000000000)`,
      )
        .bind(folderId)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("keeps rows apart across a UIDVALIDITY change", async () => {
    // The same uid under a new UIDVALIDITY is a different message, and must not
    // overwrite the old row before the folder is re-synced (#8).
    const stale = await upsert(7, "Before", "before");
    const fresh = await upsert(7, "After", "after", { uidValidity: 101 });

    expect(fresh).not.toBe(stale);
    expect(await count("messages")).toBe(2);
  });
});

describe("full-text search", () => {
  it("matches on the body and on the subject", async () => {
    const id = await upsert(1, "Quarterly invoice", "the shipment arrives on Tuesday");

    expect(await search("shipment")).toEqual([id]);
    expect(await search("invoice")).toEqual([id]);
    expect(await search("absent")).toEqual([]);
  });

  it("ranks a subject hit above a body hit under BM25", async () => {
    const inBody = await upsert(1, "Unrelated", "please read the contract before Friday");
    const inSubject = await upsert(2, "The contract", "unrelated body text");

    expect(await search("contract")).toEqual([inSubject, inBody]);
  });

  it("returns snippets, so search need never hand back a whole body", async () => {
    await upsert(1, "Notes", "the quick brown fox jumps over the lazy dog");

    const row = await env.DB.prepare(
      `SELECT snippet(messages_fts, 1, '[', ']', '...', 6) AS snip
       FROM messages_fts WHERE messages_fts MATCH 'jumps'`,
    ).first<{ snip: string }>();

    expect(row!.snip).toContain("[jumps]");
    expect(row!.snip.length).toBeLessThan("the quick brown fox jumps over the lazy dog".length);
  });

  it("stems, so a search for one word finds its inflections", async () => {
    const id = await upsert(1, "Agenda", "three meetings were scheduled");

    expect(await search("meeting")).toEqual([id]);
  });

  it("follows an upserted body rather than indexing it once", async () => {
    const id = await upsert(1, "Subject", "aardvark");
    expect(await search("aardvark")).toEqual([id]);

    await upsert(1, "Subject", "buffalo");

    expect(await search("aardvark")).toEqual([]);
    expect(await search("buffalo")).toEqual([id]);
  });

  it("drops a deleted message from the index", async () => {
    const id = await upsert(1, "Subject", "aardvark");

    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();

    expect(await search("aardvark")).toEqual([]);
  });

  it("is left alone by a flags-only update", async () => {
    // flag_message (#12) writes flags and nothing else. The update trigger is
    // scoped to subject and body_text so that write does not reindex a body.
    const id = await upsert(1, "Subject", "aardvark");

    await env.DB.prepare("UPDATE messages SET flags = '[\"Seen\"]' WHERE id = ?").bind(id).run();

    expect(await search("aardvark")).toEqual([id]);
  });

  it("round-trips non-ASCII text and folds diacritics for matching", async () => {
    const id = await upsert(1, "Café résumé", "会議は月曜日です — naïve façade");

    const row = await env.DB.prepare(
      "SELECT subject, body_text AS bodyText FROM messages WHERE id = ?",
    )
      .bind(id)
      .first<{ subject: string; bodyText: string }>();
    expect(row).toEqual({ subject: "Café résumé", bodyText: "会議は月曜日です — naïve façade" });

    expect(await search("cafe")).toEqual([id]);
    expect(await search("resume")).toEqual([id]);
    expect(await search("naive")).toEqual([id]);
  });

  it("does not word-segment CJK: a run is one token, so only a prefix matches", async () => {
    // Pinned rather than papered over. unicode61 splits on non-alphanumerics,
    // and CJK characters are alphanumeric, so "会議は月曜日です" indexes as a
    // single token. Storage is unaffected — the text round-trips exactly, as
    // the test above shows — but keyword search over CJK needs a prefix query.
    // Changing this means the trigram tokenizer, which costs stemming and a
    // full reindex; if it is ever worth it, this test is what will fail.
    const id = await upsert(1, "件名", "会議は月曜日です");

    expect(await search("会議は月曜日です")).toEqual([id]);
    expect(await search("会議*")).toEqual([id]);
    expect(await search("月曜日")).toEqual([]);
  });
});

describe("referential integrity", () => {
  it("cascades a folder delete through messages, attachments and the index", async () => {
    const id = await upsert(1, "Subject", "aardvark");
    await env.DB.prepare(
      `INSERT INTO attachments (message_id, part_index, filename, mime_type, r2_key)
       VALUES (?, 0, 'notes.txt', 'text/plain', 'msg/1/0')`,
    )
      .bind(id)
      .run();

    await env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(folderId).run();

    expect(await count("messages")).toBe(0);
    expect(await count("attachments")).toBe(0);
    expect(await search("aardvark")).toEqual([]);
  });

  it("rejects a second attachment row for the same part of a message", async () => {
    // What stops a re-sync duplicating R2 objects (#9).
    const id = await upsert(1, "Subject", "body");
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO attachments (message_id, part_index, filename) VALUES (?, 0, 'notes.txt')",
      )
        .bind(id)
        .run();

    await insert();

    await expect(insert()).rejects.toThrow(/UNIQUE/i);
  });
});

describe("the write audit log", () => {
  it("outlives the message it refers to", async () => {
    // A re-sync deletes and recreates messages. An audit row that vanished with
    // them would defeat the point of having one, so the reference goes NULL and
    // the denormalised folder/uid keep the row readable.
    const id = await upsert(7, "Subject", "body");
    await env.DB.prepare(
      `INSERT INTO write_log (tool, message_id, folder, uidvalidity, uid, outcome, detail)
       VALUES ('flag_message', ?, 'Archive', 100, 7, 'ok', 'added Flagged')`,
    )
      .bind(id)
      .run();

    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();

    const row = await env.DB.prepare(
      "SELECT message_id AS messageId, folder, uid, outcome FROM write_log",
    ).first<{ messageId: number | null; folder: string; uid: number; outcome: string }>();
    expect(row).toEqual({ messageId: null, folder: "Archive", uid: 7, outcome: "ok" });
  });

  it("records failed writes too, and nothing outside ok and error", async () => {
    await env.DB.prepare(
      "INSERT INTO write_log (tool, outcome, detail) VALUES ('move_message', 'error', 'refused')",
    ).run();
    expect(await count("write_log")).toBe(1);

    await expect(
      env.DB.prepare(
        "INSERT INTO write_log (tool, outcome) VALUES ('move_message', 'maybe')",
      ).run(),
    ).rejects.toThrow(/CHECK/i);
  });
});
