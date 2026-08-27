# 1. Run on Workers Paid, rather than redesigning for the Free plan

**Status:** accepted, 2026-08-27. Unproven — see *Validation* below.

imap-mcp runs on the Cloudflare **Workers Paid** plan and keeps the
architecture [architecture.md](../architecture.md) describes: cron enumeration,
a Queues fan-out, D1 with FTS5, R2 for attachment bytes, and `cf-imap` behind
`src/imap`. A redesign to fit inside the Workers Free plan was worked through in
detail and rejected.

## Why this was asked

Two things. The sync fan-out is the most heavily reasoned subsystem in the repo
— ranges not per-message, concurrency 4, fifty ranges a tick, gap detection
over a cursor — and yet there was no record anywhere of why *Queues* was chosen
over Workflows, Durable Object alarms, or a cron with no fan-out at all. And the
paid-plan requirement was believed to come from Queues, which is what the README
warns about above the deploy button.

Both premises turned out to be wrong.

## The fact that settles it

**The 10 ms CPU ceiling is a Workers *Free* limit, not a Workers limit.**

| | Free | Paid |
| --- | --- | --- |
| CPU per HTTP request | 10 ms | 30 s default, 5 min via `limits.cpu_ms` |
| CPU per cron trigger | 10 ms | 30 s (interval < 1 h), 15 min (interval ≥ 1 h) |
| Wall clock, cron and queue consumer | 15 min | 15 min |

Waiting on the network costs no CPU, so the IMAP round trips that dominate wall
clock are free. What is not free is MIME parsing, base64 decoding, HTML-to-text
extraction and `normalize("NFC")` — and Cloudflare's own figure for workloads
that "parse large payloads" is 10–20 ms, which is one to two times the *entire*
free budget per message. The historical free-plan burst allowance is gone from
the current docs. Exceeding the limit produces Error 1102 with a Trace Events
outcome of `exceededCpu`, classified separately from `exception` — a platform
termination, not something a `catch` can turn into a graceful failure.

So the plan upgrade that everyone assumed was the price of Queues is really the
price of parsing mail, and it buys a roughly three-thousand-fold increase in the
budget that actually binds.

**Queues has been available on the Workers Free plan since 2026-02-04**, with a
10,000 operation/day allowance and 24-hour message retention instead of the
configurable fourteen days. Neither limit binds here: a chunk body is well under
a kilobyte, a 30,000-message backfill is roughly nine hundred operations, and
nothing in the design relies on a message outliving the next hourly tick. The
barrier the docs warn about stopped existing six months ago.

## What the free-tier design would have required

This is the part worth keeping. Every item below exists only to fit inside 10 ms
or 500 MB, and all of it evaporates on the paid plan.

**Sync moves from cron-plus-Queues to a Durable Object with alarms.** An alarm
is a one-shot wake-up timer stored with the object; the handler does a slice of
work and re-arms. A single-threaded actor holding one connection gives
concurrency capping and connection reuse as *properties* rather than as
`max_concurrency` and a login-rate argument. A cron trigger survives as a
watchdog, because alarms retry six times with exponential backoff and then stop
permanently, and an alarm dated in the past can fail to fire at all — leaving
the object silently dead with nothing to look at.

**Every message is sliced across many invocations.** `BODY.PEEK[]<start.length>`
is mandatory in both RFC 3501 §6.4.5 and RFC 9051 §9 — no capability gate, no
extension document. It is 0-based, it truncates rather than erroring past EOF so
the loop self-terminates, and RFC 9051 §2.3.1.1 states normatively that a
message's `BODY[...]` data MUST NOT change for the lifetime of a
`(mailbox, UIDVALIDITY, UID)` triple. So a slice can resume across sessions:
reconnect, re-`EXAMINE`, check UIDVALIDITY, fetch the next range. RFC 4549 §4.3
recommends exactly this for disconnected clients. The matching decoder already
exists in the runtime: `Uint8Array.setFromBase64` with
`lastChunkHandling: "stop-before-partial"` writes into a pre-allocated buffer and
returns `{read, written}`, so the partial four-character group carries into the
next slice.

**`cf-imap` has to be forked**, because its `byteLimit` emits
`BODY[]<0.${byteLimit}>` with the origin hardcoded — a truncation cap, not a
range.

**The index moves from D1 into the Durable Object's own SQLite.** Free D1 caps a
*database* at 500 MB, which is roughly 30,000 messages with bodies stored; DO
SQLite lets a single object hold the full 5 GB free account allowance. FTS5
works there — workerd's authorizer allowlists exactly `fts5`, `fts5vocab`,
`rtree` and `rtree_i32` — and triggers are permitted, so the external-content
pattern ports unchanged. Rows written per day is 100,000 on both, so the write
budget is what governs backfill speed, not storage.

**Migrations stop being a deploy step.** `PRAGMA user_version` is unsupported in
DO SQLite and there is no `migrations_dir` equivalent, so schema versioning
becomes embedded SQL applied in the constructor under `blockConcurrencyWhile`,
tracked in a table. Each object migrates itself lazily on first touch after a
rollout, so old code and new schema coexist during a gradual deploy. That breaks
the ordering `test/repo/manifest.test.ts` pins, where `d1 migrations apply` runs
before `wrangler deploy`.

**Attachment bytes go.** R2 requires completing a subscription checkout, and
Cloudflare's billing policy names it as a service whose card may be
preauthorized — so a genuinely card-free deploy cannot have an R2 bucket.

**Gap detection could give way to a cursor.** Gap detection exists because ranges
complete out of order under queue fan-out, which makes a consumer-side `max()` a
lie. Serial execution in one object removes that, and a cursor becomes honest.
The invariant that must survive is the *property*, not the mechanism — no uid
range is ever permanently stepped over — so a periodic sweep is still needed as
the repair path even with a cursor doing the normal work.

The bill for all of that: a search index with no readable bodies (until DO
SQLite's headroom gave them back), no attachments, no export, no CLI against the
index, and a large amount of resume-state machinery whose only purpose is fitting
inside a limit that costs $5/month to remove.

## Other alternatives rejected

**Cloudflare Containers.** Paid-only regardless (GA 2026-04-13, `Free: N/A` for
memory, CPU and disk), so they cannot serve a free-tier goal. Disk is
confirmed ephemeral — "the next time it is started, it will have a fresh disk"
— with no persistent volume and snapshots still "coming soon", so an index
inside one is lost on every sleep and Cloudflare's own advice is to persist in
the fronting Durable Object's SQLite. Oceania is a limited-capacity placement
region and cannot be used exclusively. Containers are not on the Deploy button's
auto-provision list, and preview URLs are never generated for a Worker with
Durable Objects. A container is a good place to *parse* and a poor place to
*hold*.

**Forking [Bichon](https://github.com/rustmailer/bichon).** The closest existing
prior art — Rust, IMAP sync, embedded Tantivy index, REST API, UID-based
incremental fetch with UIDVALIDITY-change detection. Rejected on three counts:
AGPL-3.0 plus a CLA that assigns contributions; no MCP layer; and, contrary to
third-party claims, **no object-storage support at all** — its lockfile contains
no S3 crate and its README states it must not be run on a network filesystem. A
fork means replacing all three storage layers, which is the expensive part.

**Workflows, for the fan-out.** `cloudflare:sockets` is not documented as
available inside a Workflow's `run()` — the supported-contexts list names
`fetch()`, `scheduled()`, `queue()` and `alarm()` and omits it — which is
disqualifying for a job whose entire purpose is opening an IMAP connection.
There is also no documented way to cap concurrency across instances, and this
design needs one: D1 is single-threaded and the far side is one Apple account.

**Durable Objects, for the fan-out on the paid plan.** An open TCP socket keeps
the object resident and bills duration for up to fifteen minutes per connection
— which, for a workload built around holding a socket, is the whole job.
Capping concurrency becomes a naming scheme rather than a setting.

**Cron-only, no fan-out.** Gives up parallelism entirely, and the free plan
allows five cron triggers *per account*.

Queues wins on the merits it was chosen for: at-least-once delivery, a retry
budget, a dead-letter queue, and a concurrency ceiling that is one number in
`wrangler.jsonc`.

## Consequences

- **The docs are wrong in five places.** `README.md`, `docs/deploy.md`,
  the configuration docs, `scripts/setup-access.sh` and `wrangler.jsonc` all say Queues
  requires Workers Paid. The paid requirement is real, but its reason is the CPU
  limit, not Queues, and the note should say what is actually true.
- **`limits.cpu_ms` should be set**, now that it does something.
- **`max_batch_size: 1` deserves revisiting.** It was justified partly by
  invocation cost; with 30 s of CPU, several ranges over one connection becomes
  attractive, and `test/repo`'s sibling `handlers.test.ts:222` already pins that
  a multi-message batch runs over exactly one connection.
- **The one-click deploy is not free.** Anyone deploying this needs a paid
  Workers plan. That was already true; the reason given for it was wrong.

## Findings that outlive this decision

Independent of the plan, and worth acting on:

- [Exerra/cf-imap#8](https://github.com/Exerra/cf-imap/issues/8) — `decodeBytes`
  routes every `iso-8859-*` variant plus `koi8-r`/`koi8-u` through a Latin-1
  loop. Correct for ISO-8859-1 only; Greek and Cyrillic mail decodes to
  unrelated text. Fix this **before** a backfill, or the corrupted text is what
  gets indexed.
- [Exerra/cf-imap#9](https://github.com/Exerra/cf-imap/issues/9) — the
  header-only fetch requests a fixed field list with no `References` or
  `In-Reply-To`, so threading is unavailable without full bodies.
- [Exerra/cf-imap#10](https://github.com/Exerra/cf-imap/issues/10) —
  `appendChunk` copies the whole accumulated buffer per TCP chunk, so reading a
  literal is quadratic in its size.
- `Uint8Array.fromBase64` / `setFromBase64` are present in this repo's runtime at
  its current compatibility date, and beat `atob` plus a per-character loop in
  `src/sync/attachments.ts`.
- Durable Object SQLite gained real tooling: Data Studio in the dashboard
  (2025-10, beta, cannot list objects) and Local Explorer under `wrangler dev`
  (press `e`), which also exposes a scriptable local query API. What is still
  missing is any remote CLI — there is no `wrangler durable-objects` command,
  and `wrangler dev --remote` does not work with SQLite-backed objects.

## Validation

Not proven. A full backfill against a real mailbox on the current architecture
has never run — that is
[#39](https://github.com/lswith/imap-mcp/issues/39), and it is the acceptance
bar for this decision. Every capacity number reached here is an estimate: the
per-message storage figures, the backfill duration, and the claim that parsing a
message fits comfortably in 30 s have all been reasoned from documentation and
none has met a mailbox.
