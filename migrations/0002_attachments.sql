-- Attachments: the index side of #9.
--
-- The `attachments` table itself already exists — 0001 declared it, with
-- r2_key and extracted_text, and nothing wrote it. This migration adds the two
-- things storing attachments actually needs:
--
--   1. attachments_fts, so extracted text is searchable.
--   2. messages.oversize, so a message too large to fetch is a state the index
--      can express rather than a message that looks empty.
--
-- Timestamps stay INTEGER epoch milliseconds; nothing here adds one.

-- ---------------------------------------------------------------------------
-- messages.oversize
-- ---------------------------------------------------------------------------
-- Fetching a message is an operation with a size ceiling: cf-imap materialises
-- every attachment as a decoded string AND a base64 string on top of the full
-- raw message, and there is no streaming API, so a big enough message exhausts
-- the isolate rather than failing. The sync worker therefore reads RFC822.SIZE
-- for a whole uid range before it pulls any bodies, and anything above
-- SYNC_MAX_FETCH_BYTES is never body-fetched at all.
--
-- Such a message still gets a row — skipping it entirely would leave its uid
-- bucket permanently short, and gap detection (#6) would re-enqueue the range
-- on every cron tick forever. What the row cannot carry is a body, its
-- attachments, or the headers a header-only FETCH does not ask for: In-Reply-To
-- and References are absent, so reference_ids stays '[]'.
--
-- 0 or 1; SQLite has no boolean. Safe against messages_fts, which is external
-- content over (subject, body_text) and whose update trigger names those two
-- columns explicitly — a new column here reindexes nothing.

ALTER TABLE messages ADD COLUMN oversize INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- attachments_fts
-- ---------------------------------------------------------------------------
-- Its own table rather than a column on messages_fts, and that is a constraint
-- rather than a preference: FTS5 cannot have a column added to an existing
-- index, so folding attachment text into messages_fts would mean rebuilding
-- the whole thing — which here means re-running the backfill over fifteen
-- years of mail.
--
-- External content, like messages_fts: it indexes `attachments` rather than
-- holding a second copy of every extracted document. The column names must
-- match the content table's exactly, because FTS5 reads content back with
-- `SELECT filename, extracted_text FROM attachments WHERE id = ?`.
--
-- Same tokenizer as messages_fts, deliberately: a caller should not have to
-- know which index answered to know how their query was stemmed. It carries
-- the same known limitation — unicode61 does not word-segment CJK, so a run of
-- it indexes as one token and a prefix query is the way through.
--
-- filename is indexed as well as the text because it is frequently the only
-- searchable thing about an attachment: a PDF is stored but never extracted,
-- so "invoice-2024.pdf" is all there is to match on.

CREATE VIRTUAL TABLE attachments_fts USING fts5(
  filename,
  extracted_text,
  content = 'attachments',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Kept in step by the database rather than by the caller, for the reason the
-- messages_fts triggers give: writes arrive from the sync worker today and
-- from elsewhere later, and a path that forgot to reindex fails silently as a
-- missing search hit.

CREATE TRIGGER attachments_fts_insert AFTER INSERT ON attachments BEGIN
  INSERT INTO attachments_fts(rowid, filename, extracted_text)
  VALUES (new.id, new.filename, new.extracted_text);
END;

CREATE TRIGGER attachments_fts_delete AFTER DELETE ON attachments BEGIN
  INSERT INTO attachments_fts(attachments_fts, rowid, filename, extracted_text)
  VALUES ('delete', old.id, old.filename, old.extracted_text);
END;

-- UPDATE OF, matching messages_fts: a write that touches only r2_key has no
-- business reindexing an extracted document. A re-sync replaces attachment
-- rows outright (DELETE then INSERT), so it goes through the other two.
CREATE TRIGGER attachments_fts_update AFTER UPDATE OF filename, extracted_text ON attachments BEGIN
  INSERT INTO attachments_fts(attachments_fts, rowid, filename, extracted_text)
  VALUES ('delete', old.id, old.filename, old.extracted_text);
  INSERT INTO attachments_fts(rowid, filename, extracted_text)
  VALUES (new.id, new.filename, new.extracted_text);
END;
