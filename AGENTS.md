# imap-mcp

Generic IMAP → MCP server on Cloudflare Workers. Source-available, run against
one iCloud mailbox, no support commitment. See README.md for the framing.

`CLAUDE.md` is a symlink to this file — there is only one instructions file to
maintain.

## Layout

pnpm workspace, two deployable Workers and one library:

- `packages/sync` (`imap-mcp-sync`) — the **only** part of the system that
  speaks IMAP. Cron-triggered. Owns the connection and the app-specific
  password.
- `packages/mcp` (`imap-mcp-server`) — stateless MCP server. Reads the index,
  holds no mailbox credential, proxies writes to the sync worker over a service
  binding.
- `packages/imap` (`@imap-mcp/imap`) — library, not a worker. The internal
  mailbox interface, and the only place `cf-imap` is imported.

`migrations/` at the repo root is the D1 schema, shared rather than owned by
either worker: both `wrangler.jsonc` files point `migrations_dir` at it.

That split is load-bearing, not stylistic: it keeps the credential in one
worker. Do not give `packages/mcp` an IMAP connection, and do not add
`@imap-mcp/imap` to its dependencies — `packages/sync` is the only package that
may depend on it.

## Build & Test

```bash
pnpm install         # once, from anywhere in the repo — installs both packages
pnpm run lint        # biome check (lint + format)
pnpm run lint:fix    # biome check --write
pnpm run typecheck   # wrangler types + tsc --noEmit, both packages
pnpm run test        # vitest inside workerd, both packages
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run, both packages

pnpm run db:migrate:local    # wrangler d1 migrations apply, local D1
pnpm run db:migrate:remote   # ... and the deployed one
```

Per package, from `packages/sync` or `packages/mcp`:

```bash
pnpm run dev         # wrangler dev
pnpm run test:watch  # vitest
pnpm run deploy      # wrangler deploy
```

## Conventions

- **TypeScript throughout.** Biome handles lint and format; `pnpm run lint`
  covers both.
- **Nothing deployment-specific is committed.** No account IDs, zone tags,
  Access AUDs or team domains in `wrangler.jsonc` — this repo is public. They
  are documented in `.env.example` and added by whoever deploys.
- **`workers_dev` and `preview_urls` stay `false`** on both workers. Without
  them a worker is live at `<name>.<account>.workers.dev` regardless of routes
  or Access policy.
- **The app-specific password grants full mailbox access, including SMTP
  send.** It must never reach a log line, including error paths, and an auth
  failure must fail loudly rather than retry — a revoked password retried at
  queue speed is how an Apple ID gets locked.
- **Message bodies are attacker-controlled text.** Anything returned to a model
  gets an explicit untrusted-content envelope.

## Status

Early. The mailbox interface (`packages/imap`, #3), the D1 schema
(`migrations/`, #4), the tracer sync (#5), the queue fan-out (#6), incremental
sync (#8), the MCP server (`packages/mcp`, #7) and the Access gate
(`packages/mcp/src/access.ts`, #10) are implemented and tested. The rest is
tracked as issues on this repo: #9 attachments, #11 `get_message` and
`get_thread`, #12 write tools, #24 flag reconciliation. See the roadmap table
in README.md for the full list, and docs/access.md for the Access setup.

Constraints already built into `packages/imap`, because the tickets downstream
of it depend on them: everything is addressed by UID, fetches always PEEK,
`ENABLE` is connection configuration so it cannot be issued after the first
`SELECT`, flag writes are verified by reading back, and `EXPUNGE` is reachable
only as `UID EXPUNGE` over an explicit set.

The same goes for the schema, and these are the ones downstream tickets will
trip over if they are not known:

- Every message write is an **upsert on `(folder_id, uidvalidity, uid)`** —
  queue delivery is at-least-once, so nothing may assume it runs once.
- `messages.body_text` is a **real column**, not only FTS content. It is the
  seam semantic search would be built on; do not turn it into index-only.
- **Timestamps are INTEGER epoch milliseconds** everywhere.
- `messages_fts` is **external content plus triggers**. Writes to `messages`
  reindex themselves; a flags-only `UPDATE` deliberately does not. Adding an
  FTS column or changing the tokenizer needs a full reindex, so #9 gets its own
  FTS table over `attachments.extracted_text` rather than a column here.
- **There is no `wrangler d1 export`** for this database — it refuses to run
  against FTS5 — so re-running the backfill is the recovery path.
- No `database_id` is committed; the binding is provisioned on first deploy.
  Both workers must end up on the *same* database.

And from the sync worker (`packages/sync`, #5 and #6), for the same reason:

- **Nothing in `packages/sync` calls `console.*` directly.** Every line goes
  through `createLogger(env)` (`src/log.ts`), which scrubs the password in each
  form it could come back off the wire. Adding a bare `console.log` is how that
  guarantee gets lost.
- **Bodies are normalised at index time, not at read time** (`src/normalise.ts`):
  HTML reduced with `HTMLRewriter`, hidden elements dropped, character
  references decoded *before* hidden characters are stripped — `&#8203;` is a
  zero-width space, and a filter that ran the other way round would miss it.
- **`runSync` takes a `connect` seam** because the protocol cannot be faked
  inside workerd: `cloudflare:sockets` is a runtime built-in there, so
  `packages/imap`'s scripted-server harness only runs under Node. Real protocol
  coverage belongs in `packages/imap`; `packages/sync` drives a fake `Mailbox`.
- **Configuration is declared in `src/env.d.ts`, not in `wrangler.jsonc`.** No
  `vars` block is committed, so `wrangler types` cannot generate those entries.
  `readSyncConfig` turns an absent one into a named failure that does not retry.
- **`runSync` is gone.** The cron enumerates (`src/enumerate.ts`) and a queue
  consumer fetches (`src/consume.ts`); `src/session.ts` holds the `connect`
  seam and the guarded close they share. There is no single function that does
  a sync end to end any more, and reintroducing one would put a mailbox's worth
  of work back inside one invocation.
- **What to enqueue is decided by gap detection, not by a cursor.**
  `indexedBuckets` (`src/store.ts`) asks D1 how many rows each uid bucket
  already holds, and only short buckets are queued. Three things depend on it:
  a folder converges instead of re-fetching hourly, a dead-lettered range comes
  back next tick rather than being stepped over, and the watermark can be the
  highest uid *below the first gap* rather than a lie about contiguity.
- **Buckets are absolute** — bucket *n* is uids `n*size+1 .. (n+1)*size`,
  counted from uid 1. The arithmetic in `src/queue.ts` and the SQL in
  `src/store.ts` have to agree, so both take the size rather than assuming it.
  Changing `SYNC_CHUNK_UIDS` moves every boundary and re-enqueues the folder
  once; the upsert makes that wasteful rather than wrong.
- **Consumers never write the watermark.** Ranges complete out of order under
  fan-out, so `max(last_synced_uid, ...)` from a consumer would claim a
  contiguity that does not exist. Enumeration owns that column.
- **An auth failure on the queue path acks the batch; it does not retry it.**
  Re-attempting a revoked password across every consumer at once is faster at
  locking an Apple ID than the cron path ever was. Nothing is lost — the next
  tick re-enumerates whatever the batch did not store.
- **Consumer concurrency is capped at 4** in `wrangler.jsonc`, and that is not
  timidity: D1 is a single, single-threaded Durable Object, so high fan-out
  relocates the bottleneck while hammering Apple. Raise it only with a reason.
- **Enumeration `SEARCH`es on uid ranges and dates and nothing else.** Size and
  string criteria are unusable against iCloud (`LARGER` matches everything,
  `SMALLER` nothing, `SUBJECT`/`TEXT`/`FROM` return no hits). A test asserts
  the criteria object has no other keys, so adding one fails the build.
- **Enumeration resumes from the watermark, and gap detection is scoped to the
  same floor.** `indexedBuckets` takes an `aboveUid` and the walk starts at
  `watermark + 1`. Matching the two is correctness, not thrift: the bucket
  straddling the watermark also holds rows below it, and counting the whole
  bucket against the partial member list `SEARCH` returns would read an
  incomplete bucket as complete and skip it for good.
- **The walk is bounded by uid space, not by `EXISTS`.** Counting scanned uids
  against `EXISTS` was right when every run started at uid 1. It is wrong now:
  `EXISTS` counts what the folder holds, the rows below the watermark count
  what D1 holds, and one message deleted upstream makes the second larger —
  which would end the walk before it reached anything new.
- **A folder whose watermark has reached `uidNext - 1` is skipped with no
  `SEARCH` at all.** That is the quiet-tick path and the point of #8. It does
  not fire when the folder's newest uid was deleted upstream; one empty
  `SEARCH` a run is cheaper than the mechanism that would avoid it.
- **CONDSTORE is enabled session-wide and confirmed by `HIGHESTMODSEQ`, never
  by the `ENABLE` reply.** `mailboxConfig` (`src/session.ts`) is where the list
  is set, and it exists as a separate function only so a test can assert it —
  every other test injects `deps.connect` and never reaches the real one, and a
  missing `ENABLE` produces no error at all. Nothing reads a mod-sequence yet;
  #24 is where the recorded value gets used.
- **A folder that is not on the server warns and is skipped; it does not fail
  the run.** One `LIST` per enumeration decides, because a tagged `NO` on
  `SELECT` cannot be told apart from any other. Consumers ask the same question
  only on the `selectFolder` failure path, and a `LIST` that itself fails
  answers "still there" — a range must never be dropped on the strength of a
  question that went unanswered.

And from the MCP server (`packages/mcp`, #7), which is where anything reaching a
model is decided:

- **`createMcpHandler` comes from `@modelcontextprotocol/server`**, the official
  SDK, not from Vercel's `mcp-handler` wrapper and not from the deprecated
  `McpAgent`. It runs on workerd because the package's `./_shims` export has a
  `workerd` condition that swaps Ajv — which needs `eval` — for a bundled
  `@cfworker/json-schema` validator. Nothing in this package may import
  `@modelcontextprotocol/server/stdio`.
- **The handler is built per request, in `fetch`.** The factory it takes is
  handed no `env`, so a handler held at module scope would close over whichever
  `env` arrived first. Per-request construction is a couple of cheap objects and
  it is what "stateless" actually means here.
- **No user string reaches `MATCH` as syntax.** `toMatchExpression`
  (`src/fts.ts`) re-emits every term as an FTS5 string literal, because an
  unbalanced quote or a bare `*` is a syntax error, not a search. A trailing `*`
  survives on purpose: `unicode61` indexes CJK as one token and the prefix query
  is the documented workaround.
- **Message bodies never leave this worker.** `search.ts` searches `body_text`
  and snippets it and never selects it. A broad query that put a hundred bodies
  in front of a model is the injection surface the whole design is arranged
  around, which is also why the result count has a ceiling a caller cannot lift.
- **The untrusted-content envelope carries a nonce drawn per response**
  (`src/untrusted.ts`). A fixed delimiter is a fixed string, and a subject line
  written months ago can contain it; a nonce cannot be known at the time the
  message was sent, so the closing tag is the one thing in the output an author
  cannot forge. Subjects and snippets are flattened to one line for the same
  reason — a newline would otherwise let a body add rows to the result list it
  appears in. There is deliberately no `structuredContent`: a JSON copy of the
  same text would reach the model outside the frame.
- **Search joins on the folder's current `uidvalidity`.** A folder that changed
  it leaves the previous generation in `messages` rather than colliding with it,
  so without the join every message in a re-synced folder comes back twice —
  half of them under uids that no longer address anything on the server.
- **Origin is validated, Host is not.** On Workers `request.url` is built from
  the Host header, so checking one against the other answers nothing. Origin is
  what separates a browser from an MCP client: clients send none and pass, a
  page on another site sends its own and is turned away. The one place Host is
  reflected is the RFC 9728 document, which asserts nothing but the hostname the
  caller itself asked for.

And from the Access gate (`packages/mcp/src/access.ts`, #10), which is the
load-bearing control in the whole design rather than hygiene on top of it:

- **The token the client holds and the token the worker checks are different
  things.** Managed OAuth issues the *client* an opaque token (`oauth:...`) that
  only Access can verify; Access exchanges it at the edge and forwards a signed
  JWT in `Cf-Access-Jwt-Assertion`. So the gate reads that header, never
  `Authorization`. Anyone "fixing" it to read the bearer token would be trusting
  a string this worker cannot read.
- **`aud` is pinned, and that is the half that does the work.** Every
  application in one Zero Trust account is signed by the same team keys, so a
  signature-and-issuer check admits users of any of them — including an
  application whose policy lets the whole internet in. `algorithms: ["RS256"]`
  and `requiredClaims: ["exp"]` are pinned for the same reason and are not
  belt-and-braces: a test proves that without them an HS256 token signed with a
  guessed secret, and a token carrying no expiry at all, both verify.
- **Verified here rather than trusted from the edge**, which is what makes the
  gate survive a mistake in front of it — a route added before the Access
  application exists, a policy edited to bypass, an origin reachable by some
  path that did not traverse Access. The native `ctx.access` API is deliberately
  not used: it is edge-provided identity, which is the thing this ticket set out
  not to rely on, and it postdates the compat date the vitest pool's workerd
  caps at.
- **Absent configuration is a 500, never a pass and never a 401.** A 401 would
  invite a client into an OAuth flow that cannot succeed; a 403 would claim a
  correct credential was rejected and send the deployer to edit the wrong thing.
  What must never happen is the third option. `readAccessConfig` returns an
  outcome rather than throwing, matching `SearchOutcome` in `src/search.ts`, so
  the failure cannot be walked past by forgetting a `catch`.
- **An unreachable JWKS answers 503, not 401.** Reporting it as `invalid_token`
  tells a client its perfectly good session was revoked, sending it back through
  OAuth for a token that fails identically — a browser window at the user for
  what is usually a blip. The jose errors that judge the *token* are enumerated
  explicitly, because the interesting ones are not subclasses: a certs endpoint
  answering 404 throws the *base* `JOSEError`, so "is it a JOSEError" would call
  an outage the caller's fault. Anything unrecognised falls to 503 deliberately.
- **The order in `fetch` is discovery → 404 → Origin → Access, and the Origin
  step is not swappable.** A DNS-rebound browser request carries the victim's
  Access cookie, so the edge attaches a genuine assertion and the Access check
  *passes*. Origin is the only thing that stops it, so it must not be reachable
  past by holding a valid session.
- **`/.well-known/oauth-protected-resource` is served unauthenticated, ahead of
  everything.** The MCP authorization spec makes RFC 9728 metadata a MUST, and
  the `resource_metadata` pointer in this worker's own 401 has to lead
  somewhere — otherwise the one case where that 401 fires is the case where its
  pointer hits the 404. With Access in front, the edge answers first and this
  copy is never reached; its audience is the backstop and `wrangler dev`.
- **The JWKS set is cached at module scope keyed by team domain, unlike the
  handler, which is built per request.** The handler closes over `env`; a key
  set closes over a URL, so keying the map by that URL makes the closure hazard
  structurally impossible. jose's cache and cooldown live *inside* the object
  `createRemoteJWKSet` returns, so rebuilding it per request means a certs
  subrequest on every single tool call.
- **`wrangler dev` answers 401 to everything, and that is correct.** Nothing
  attaches the assertion header locally. The tests mint real RS256 assertions
  against a throwaway tenant generated per run in `vitest.config.ts` and served
  back through `outboundService`, so no key is committed and a passing test
  proves a real signature was verified — not that a check was stubbed out.
