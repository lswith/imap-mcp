-- imap-mcp initial schema (#4).
--
-- The storage layer the whole system reads and writes: the sync worker
-- (packages/sync) fills it from IMAP, the MCP server (packages/mcp) serves it
-- to a model, and neither holds mailbox state anywhere else.
--
-- Two decisions here are load-bearing rather than stylistic:
--
--   1. messages.body_text is a REAL COLUMN, not only FTS index content. That
--      is the seam that lets semantic search be added later by reading this
--      database instead of re-pulling fifteen years of mail from iCloud.
--
--   2. Messages are keyed on (folder, uidvalidity, uid), so every write can be
--      an upsert. Queue delivery (#6) is at-least-once and consumers must be
--      safe to re-run. UIDPLUS is available on iCloud and every APPEND returns
--      an APPENDUID, so that key comes back from the server on every write
--      rather than needing a re-fetch to discover.
--
-- Timestamps are INTEGER epoch MILLISECONDS throughout, so a JavaScript Date
-- round-trips exactly (MailboxMessage.internalDate is a Date) and comparisons
-- are numeric. To read one by eye:
--   SELECT datetime(internal_date / 1000, 'unixepoch') FROM messages;
--
-- Note for recovery: `wrangler d1 export` refuses to run against a database
-- containing an FTS5 virtual table, and this one has messages_fts. There is
-- therefore no working export of this database — re-running the backfill is
-- the recovery path. See README.md.

-- ---------------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------------
-- One row per IMAP mailbox, carrying UIDVALIDITY and the sync watermark that
-- incremental sync (#8) reads and writes.

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Full IMAP name including hierarchy, e.g. "Archive" or "Lists/rust-dev".
  name TEXT NOT NULL UNIQUE,
  -- Hierarchy delimiter, e.g. "/". Empty string when the server reports NIL.
  delimiter TEXT NOT NULL DEFAULT '',
  -- JSON array of attributes, backslash stripped, e.g. ["HasNoChildren"].
  attributes TEXT NOT NULL DEFAULT '[]',

  -- If this changes between syncs, every uid recorded against this folder is
  -- meaningless and the folder must be re-synced from scratch (#8). Messages
  -- carry their own copy so old rows stay addressable while that happens.
  uidvalidity INTEGER,
  uid_next INTEGER,
  -- HIGHESTMODSEQ (CONDSTORE, RFC 7162). Its presence, not the ENABLE reply,
  -- is how to tell CONDSTORE is actually in effect for this folder.
  highest_modseq INTEGER,

  -- The watermark: the highest uid successfully synced under the uidvalidity
  -- above. A subsequent run enumerates only uids beyond it (#8).
  last_synced_uid INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,

  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
-- The envelope fields plus the normalised plain-text body.
--
-- There is deliberately no body_html column. HTML is reduced to plain text at
-- index time, with hidden and zero-width characters stripped (#5), and storing
-- both copies would double the largest thing in this database for a second
-- rendering nothing reads. get_message (#11) serves body_text.

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  -- Denormalised from folders so the upsert key is self-contained: a sync that
  -- observes a new UIDVALIDITY can write new rows before the old ones are
  -- cleared out, rather than colliding with them.
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,

  -- The RFC 5322 Message-ID header, not a foreign key. Named rfc_message_id
  -- because attachments.message_id and write_log.message_id are integer
  -- references to messages(id), and a bare "message_id" in a mail schema is
  -- genuinely ambiguous between the two.
  rfc_message_id TEXT,
  in_reply_to TEXT,
  -- JSON array of Message-IDs from the References header, for get_thread (#11).
  -- Not named "references": REFERENCES is a SQL keyword.
  reference_ids TEXT NOT NULL DEFAULT '[]',

  subject TEXT NOT NULL DEFAULT '',
  -- Lowercased first sender address, for search_messages' sender filter (#7).
  -- from_addresses keeps the full list as the server gave it.
  from_address TEXT,
  from_addresses TEXT NOT NULL DEFAULT '[]',
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',

  -- INTERNALDATE: when the server received it. Always present.
  internal_date INTEGER NOT NULL,
  -- The Date header: when the sender claims it was sent. Attacker-controlled
  -- and frequently absent or nonsense, so date filters should prefer
  -- internal_date.
  sent_date INTEGER,

  size_bytes INTEGER,
  -- JSON array of flags, backslash stripped, e.g. ["Seen","Flagged"]. Updated
  -- in place by flag_message (#12) without touching the FTS index.
  flags TEXT NOT NULL DEFAULT '[]',

  -- The normalised plain-text body. A real column, indexed into messages_fts
  -- by trigger rather than stored twice.
  body_text TEXT,

  has_attachments INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  -- The upsert key. Every write is INSERT ... ON CONFLICT DO UPDATE against it.
  UNIQUE (folder_id, uidvalidity, uid)
);

CREATE INDEX messages_rfc_message_id ON messages(rfc_message_id);
CREATE INDEX messages_internal_date ON messages(internal_date DESC);
CREATE INDEX messages_from_address ON messages(from_address);
CREATE INDEX messages_folder_date ON messages(folder_id, internal_date DESC);

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------
-- Metadata only. The bytes go to R2 (#9): D1's per-value limit is 2 MB, and
-- pulling attachments at sync time rather than on demand is what keeps IMAP —
-- and therefore the credential — confined to the sync worker.

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,

  -- Position in the message's attachment list. Deterministic per fetch, so
  -- with the UNIQUE below a re-sync overwrites its rows and its R2 objects
  -- instead of duplicating them (#9).
  part_index INTEGER NOT NULL,

  filename TEXT,
  mime_type TEXT,
  -- Size of the decoded content.
  size_bytes INTEGER,
  -- The original Content-Transfer-Encoding, e.g. "base64".
  encoding TEXT,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,

  -- Key of the object in R2. Derived from the message and part_index so it is
  -- stable across re-syncs.
  r2_key TEXT,
  -- Extracted text for .txt, .md, .csv and .docx (#9). PDFs are stored but not
  -- indexed: there is no good Workers-native parser, so this stays NULL for
  -- them. #9 adds its own FTS table over this column rather than a column in
  -- messages_fts, because FTS5 columns cannot be added to an existing index.
  extracted_text TEXT,

  UNIQUE (message_id, part_index)
);

CREATE INDEX attachments_message ON attachments(message_id);

-- ---------------------------------------------------------------------------
-- write_log
-- ---------------------------------------------------------------------------
-- Every mailbox write the MCP server proxies to the sync worker (#12), whether
-- it succeeded or failed. This is the control that matters: it turns hidden
-- mischief by an injected instruction into a list you can look at.
--
-- Nothing written here may ever carry the app-specific password or any part of
-- it — that credential grants full mailbox access including SMTP send, and
-- these rows are meant to be read.

CREATE TABLE write_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  -- flag_message, move_message, create_draft.
  tool TEXT NOT NULL,
  -- Cloudflare Access identity of the caller (#10). NULL until then.
  actor TEXT,

  -- ON DELETE SET NULL, not CASCADE: an audit row must outlive a re-sync that
  -- deletes and recreates the message it referred to. The folder/uid columns
  -- below are denormalised for exactly that reason — the row has to stay
  -- self-describing once this is NULL.
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  folder TEXT,
  uidvalidity INTEGER,
  uid INTEGER,

  -- JSON of the tool arguments, as the model supplied them.
  arguments TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  -- Free text: the destination folder, the flags set, or the error.
  detail TEXT
);

CREATE INDEX write_log_at ON write_log(at DESC);

-- ---------------------------------------------------------------------------
-- messages_fts
-- ---------------------------------------------------------------------------
-- External content: the index points at messages rather than holding a second
-- copy of every body. Against fifteen years of mail and D1's 10 GB per-database
-- ceiling that is the difference between fitting and not.
--
-- The column names must match the content table's exactly — FTS5 reads content
-- back with `SELECT subject, body_text FROM messages WHERE id = ?` — which is
-- why the body column is body_text on both sides.
--
-- Neither the column set nor the tokenizer can be changed in place; both need
-- the index rebuilt, which here means re-running the backfill. So:
--   porter               stems, so "meeting" matches "meetings"
--   remove_diacritics 2  the Unicode-correct variant, so "cafe" finds "café"
--
-- Known limitation, pinned by a test rather than left to be rediscovered:
-- unicode61 splits on non-alphanumerics, and CJK characters are alphanumeric,
-- so a run like "会議は月曜日です" indexes as ONE token. The text stores and
-- reads back exactly; it is keyword search over it that is coarse, and a
-- prefix query ("会議*") is the way through. Fixing it properly means the
-- trigram tokenizer, which costs stemming and a full reindex.
--
-- BM25 is then available to search_messages (#7) as, for example:
--   SELECT ... FROM messages_fts WHERE messages_fts MATCH ?
--   ORDER BY bm25(messages_fts, 10.0, 1.0)
-- weighting a subject hit above a body hit.

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  body_text,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keeping the index in step is the database's job, not the caller's: writes
-- arrive from the sync worker today and from the write tools later (#12), and
-- a path that forgot to reindex would fail silently as a missing search hit.

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.id, new.subject, new.body_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.id, old.subject, old.body_text);
END;

-- UPDATE OF, not a bare UPDATE: a flag write (#12) touches flags alone and has
-- no business reindexing a whole body. An upsert always assigns both columns,
-- so it still fires.
CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.id, old.subject, old.body_text);
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.id, new.subject, new.body_text);
END;
