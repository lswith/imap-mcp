# imap-mcp — rules for working in this repo

Generic IMAP → MCP server on Cloudflare Workers: one Worker, one package, at
the repository root. `CLAUDE.md` is a symlink to this file.

This file is the rules. The reasoning behind them lives in
[docs/architecture.md](./docs/architecture.md) — read it before changing the
sync path, the schema, or anything that reaches a model. Deploy mechanics are
[docs/deploy.md](./docs/deploy.md); the auth modes are
[docs/authentication.md](./docs/authentication.md); the contribution contract
is [CONTRIBUTING.md](./CONTRIBUTING.md).

## Layout

`src/index.ts` exports the Worker's three entry points: `fetch` (MCP server),
`scheduled` (sync enumeration), `queue` (fetch consumers).

- `src/imap/` — the mailbox interface; the only place `cf-imap` is imported.
- `src/sync/` — everything that speaks IMAP. Write-policy refusals live here.
- `src/mcp/` — auth gate, tools, untrusted-content envelope, audit log.
- `src/writes.ts` — the `WriteService` contract between the two halves.
- `migrations/` — the D1 schema.

Tests: `test/sync`, `test/mcp`, `test/imap/unit` and `test/repo` run inside
workerd against the repo's own `wrangler.jsonc`; `test/imap/protocol` runs the
real cf-imap client against a scripted server under Node. A change to provider
behaviour must come with a protocol-harness test (see CONTRIBUTING.md).

## Commands

```bash
pnpm install         # single package, no workspace
pnpm run lint        # biome check;  lint:fix to write
pnpm run typecheck   # wrangler types + tsc --noEmit
pnpm run test        # vitest, both projects;  test:watch, test:coverage
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run
pnpm run dev         # wrangler dev (API-key mode locally)
pnpm run deploy      # d1 migrations apply + wrangler deploy, in that order
pnpm run db:migrate:local / db:migrate:remote
```

## Rules that must survive any change

Each of these is load-bearing; most are pinned by a test or a lint. Breaking
one is a design change, not a refactor — take it to an issue first.

**Credential and logging**

- The app-specific password grants full mailbox access including SMTP send. It
  must never reach a log line. Nothing in `src/sync` calls `console.*`
  directly — every line goes through `createLogger(env)` (`src/sync/log.ts`),
  which scrubs the password in every form it comes back off the wire.
- An auth failure against the mailbox fails loudly and is never retried —
  not by the cron, not by a queue consumer (the batch is acked), not by a
  write tool. A revoked password retried at queue speed locks an Apple ID.
- `cf-imap` and `cloudflare:sockets` are importable only from
  `src/imap/cf-imap-mailbox.ts` — enforced by `noRestrictedImports` in
  `biome.json`. The supply-chain control that replaced the old two-Worker
  split is the four-day `minimumReleaseAge` in `pnpm-workspace.yaml`; never
  remove or shorten it to fix an install.

**Sync correctness**

- Every message write is an upsert on `(folder_id, uidvalidity, uid)`; queue
  delivery is at-least-once, so nothing may assume it runs once.
- Consumers never write the watermark — enumeration owns it. Ranges complete
  out of order, and a consumer-side `max()` would claim contiguity that does
  not exist.
- What to enqueue is decided by gap detection (`indexedBuckets`,
  `src/sync/store.ts`), not a cursor. Buckets are absolute (bucket *n* = uids
  `n*size+1 .. (n+1)*size`); the arithmetic in `src/sync/queue.ts` and the SQL
  must agree, so both take the size.
- Gap detection is scoped to the same floor enumeration resumes from
  (`aboveUid` = watermark), and the walk is bounded by uid space, not
  `EXISTS`. Mismatching either skips mail for good.
- Enumeration `SEARCH`es on uid ranges and dates and nothing else — size and
  string criteria are unusable against iCloud. A test asserts the criteria
  object has no other keys.
- CONDSTORE is enabled at connect (`mailboxConfig`, `src/sync/session.ts`) and
  confirmed by `HIGHESTMODSEQ` arriving, never by the `ENABLE` reply.
- A folder missing upstream warns and is skipped; a `LIST` that itself fails
  answers "still there". A range must never be dropped on an unanswered
  question.
- Consumer concurrency stays at 4 (`wrangler.jsonc`) unless you have a
  measured reason: D1 is single-threaded and the far side is one Apple
  account.
- Nothing an indexing run does can change the mailbox: `EXAMINE`, always
  `PEEK`. `FakeMailbox` (`test/sync/support`) throws from every mutating
  method to prove it — keep it that way.

**Attachments (#9)**

- R2 bytes are written *before* the D1 message row; a failed put means no row.
  Gap detection counts rows, so reversing this is silent data loss. The R2
  writes are not `waitUntil`-ed for the same reason.
- The R2 key is derived — `att/<folder_id>/<uidvalidity>/<uid>/<part_index>` —
  never generated.
- A message and its attachment rows go in one `db.batch()`; attachment rows
  are deleted and reinserted, not upserted.
- Fetchability is decided from a header-only `RFC822.SIZE` pass before any
  bytes move; an oversize message still gets a row (`messages.oversize`), or
  its bucket stays short forever. `SYNC_MAX_FETCH_BYTES` is both the fetch
  budget and the per-message ceiling, deliberately one knob.
- A failed attachment decode is never a failed message (null `r2_key`, warn);
  an extractor that can throw must swallow its own failures and answer null.
- Text is extracted for `.txt`, `.md`, `.csv` only; the extension wins. R2
  objects carry no `httpMetadata` — author-chosen content types are a loaded
  gun for whoever serves the bytes later.

**Anything that reaches a model (`src/mcp`)**

- Message bodies are attacker-controlled text. Everything message-derived is
  returned inside the untrusted-content envelope (`src/mcp/untrusted.ts`) with
  a per-response nonce; there is deliberately no `structuredContent`.
- Bodies leave the Worker one at a time, by id, only through `get_message`,
  capped at `MAX_BODY_CHARS`. Search and threads never return a body, result
  counts and thread sizes have ceilings a caller cannot lift, and no retrieval
  tool takes an offset — paging would reassemble in bulk what the cap refused.
- Line-rendered fields (subjects, snippets, previews, recipients, filenames)
  are collapsed to one line; a body is one region between two tags and is not.
- No user string reaches FTS5 `MATCH` as syntax — `toMatchExpression`
  (`src/mcp/fts.ts`) re-emits every term as a string literal.
- An error string from `src/mcp` never quotes mailbox text; a reason string is
  outside every frame.
- Search joins on the folder's current `uidvalidity`; `get_message`
  distinguishes "no such id" from "stale generation" in TypeScript.
- Threading is reference headers, in one round, and nothing else. The subject
  fallback was removed because it could not be made correct — do not
  reintroduce it without a `subject_key` column written at index time
  (docs/architecture.md has the full history).
- Duplicated messages (same Message-ID, several folders) are returned as
  separate rows, never collapsed — each is a distinct write target.
- "No attachment rows", "attachments present but unindexed", "never fetched"
  and "none" are four different claims; keep them apart, and say "oversize"
  rather than "no body".
- The MCP handler is built per request, from the official
  `@modelcontextprotocol/server` SDK; nothing may import its `/stdio` entry.

**Authentication (`src/mcp/auth.ts`)**

- Two modes, precedence not fallback: `ACCESS_AUD` set → Access required, API
  key refused; unset → the key, as a bearer token only, compared in constant
  time over digests. The two are never both accepted.
- The unconfigured case is guarded at deploy time (`secrets.required` in
  `wrangler.jsonc`); do not reintroduce a runtime branch on a secret's
  absence — the generated types make them non-optional on purpose.
- The gate reads `ctx.access`, never a header, and the `aud` comparison is the
  whole security decision in Access mode — a test stubs it out to prove a
  caller for another application walks in; that test must survive.
- Request order in the fetch path: discovery → 404 → Origin → auth. Origin
  must run before auth in both modes — an authenticated (or key-bearing)
  DNS-rebound browser request is the case it exists for.
- The RFC 9728 discovery document is served unauthenticated, ahead of
  everything. Access-mode 401s carry the OAuth challenge with
  `resource_metadata`; API-key-mode 401s carry a bare bearer challenge with no
  OAuth pointer.
- Tests call `handleRequest` directly with a fabricated context — `SELF` is a
  service binding and Access never propagates `ctx.access` across one. Whether
  Cloudflare populates `ctx.access` in production is the one thing no test can
  prove; the post-deploy check in docs/authentication.md is not optional.

**Writes (#12)**

- Every refusal lives in `src/sync` (the mailbox layer), never in `src/mcp`.
  The tool layer resolves ids, audits, and decides nothing.
- Reads of `messages` on the write path join the folder's current
  `uidvalidity` — a write must refuse a renumbered generation, not merely hide
  it.
- `\Deleted` is set in exactly one function (`moveMessage`), on one uid,
  after a confirmed `COPYUID`; the flag write is read back before the
  `UID EXPUNGE`, and the expunge is confirmed before the index row is
  dropped. `ALLOWED_FLAGS` is an allowlist; `DENIED_DESTINATIONS` refuses
  Trash and Junk. Each step gates the next — the order is the safety argument.
- Audit rows are written by the tool layer in two statements: intent recorded
  as `error` before the write, updated after. A write returns an outcome and
  never throws across the seam.
- The write seam is the `WriteService` parameter on `handleRequest`
  (default: real `createWriteService(env)`); tests inject a fake. Mailbox-side
  write behaviour is tested in `test/sync` against `WritableMailbox`, whose
  flat `writes` list is what makes the copy-mark-expunge order assertable.
- Flag changes are not written back to D1 (the mailbox is the source of truth;
  #24 reconciles). A move deletes the source row — after `UID EXPUNGE` the uid
  addresses nothing.

**Schema and platform**

- `messages.body_text` is a real column, not FTS-only — it is the seam
  semantic search would build on.
- `messages_fts` is external content plus triggers; a flags-only UPDATE
  deliberately does not reindex. New FTS columns or tokenizer changes need a
  full reindex — which is why `attachments_fts` is its own table.
- Timestamps are INTEGER epoch milliseconds everywhere.
- There is no `wrangler d1 export` (FTS5); re-running the backfill is the
  recovery path.
- No account-specific value is committed: no account id, database id, audience
  tag, or mailbox address. Wrangler's `database_id` write-back is correct in a
  fork and must never be pushed upstream.
- `workers_dev` stays `true` (the auth gate holds the line); `preview_urls`
  stays `false`. Migration scripts reference the D1 *binding* (`DB`), never
  the database name, and migrations run inside the `deploy` script — both
  pinned by `test/repo/manifest.test.ts`.
- Commit messages follow Conventional Commits; the changelog is generated from
  them.
