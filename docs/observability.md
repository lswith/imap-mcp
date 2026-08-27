# Watching a deployed instance

You deployed it. Is it working?

That question is harder than it should be for this Worker, and not by accident:
it has no UI, its interesting half runs on a cron trigger an hour from now, and
a client that cannot connect gets the same 401 whether the key is wrong or
Cloudflare Access is misconfigured. This page is how to answer it — in the
order the questions actually arrive.

## The short version

```bash
# 1. What does the instance say about itself?  (needs your credential)
curl -s -H "Authorization: Bearer $MCP_API_KEY" https://<worker>.workers.dev/status | jq

# 2. What is it doing right now?
pnpm exec wrangler tail --format pretty

# 3. What did it do earlier?
#    Dashboard -> Workers & Pages -> imap-mcp -> Logs  (kept for 7 days)
```

If `/status` answers, the deploy is healthy and authenticated. Everything after
that is about what the *sync* is doing.

## `GET /status`

One JSON document, behind the same gate as `/mcp` — the API key as a bearer
token, or Cloudflare Access once `ACCESS_AUD` is set. It is not public: it
names folders, a hostname and a mailbox user. `200` when every check it can
make itself passed, `503` when one did not, so a shell can branch on it.

```jsonc
{
  "ok": true,
  "checkedAt": "2026-08-27T21:00:00.000Z",
  "worker": { "logLevel": "info" },
  "auth": { "mode": "api-key" },          // which credential is accepted RIGHT NOW
  "config": {
    "ok": true,
    "mailbox": "imap.mail.me.com:993",
    "user": "you",
    "summary": "imap.mail.me.com:993; folders Archive; 100 uids/range; ..."
  },
  "schema": { "ok": true, "migrations": 2 },
  "index": {
    "messages": 45736,
    "attachments": { "rows": 2109, "stored": 2094, "extracted": 61 },
    "folders": [
      {
        "name": "Archive",
        "uidValidity": 1,
        "uidNext": 45920,                 // the top of the uid space
        "watermark": 4700,                // everything at or below this is indexed
        "messages": 45736,
        "oversize": 13,
        "staleRows": 0,                   // rows under a PREVIOUS uidvalidity
        "oldest": "2008-04-29T11:03:08.000Z",
        "newest": "2026-08-26T08:41:30.000Z",
        "lastWrite": "2026-08-27T20:07:13.000Z",
        "converged": false,               // watermark has reached uidNext - 1
        "stalled": true                   // rows above a watermark that stopped
      }
    ]
  },
  "writes": { "total": 0, "failed": 0, "lastAt": null }
}
```

### Reading it

| What you see | What it means |
| --- | --- |
| `config.ok: false` | The cron is failing hourly with the same message. The named variable is not set — see [Configuration](#where-configuration-lives) below. |
| `schema.ok: false` | Migrations never ran: `pnpm run db:migrate:remote`. Every tool would otherwise fail with a missing-table error. |
| `index.messages: 0`, config fine | Nothing has been indexed yet. The cron runs hourly; wait for the next tick and look again. |
| `converged: true` | Done. The folder is fully indexed and the hourly tick is nearly free. |
| `converged: false`, `stalled: false` | A backfill in progress. Roughly 5,000 messages an hour at the defaults. |
| `stalled: true` | **The one that needs you.** See [When a folder stalls](#when-a-folder-stalls). |
| `staleRows` large | The folder was renumbered upstream (`UIDVALIDITY` changed); those rows are unreachable and the folder is re-indexing from uid 1. |
| `writes.failed` climbing | The write tools are being refused. Every attempt is in the `write_log` table with its reason. |

### The mailbox probe

```bash
curl -s -H "Authorization: Bearer $MCP_API_KEY" \
  "https://<worker>.workers.dev/status?probe=mailbox" | jq .mailbox
```

Opens **one** connection, lists folders, reports whether the folders you
configured are there, and closes. It is the only check here that leaves the
Worker, and the only one that answers "is the app-specific password still
good?" without waiting for the next cron tick.

Ask it while you are debugging. **Do not poll it.** An app-specific password
re-attempted in a loop is how an Apple ID gets locked, which is why nothing
else in this Worker ever retries an authentication failure either.

## Logs

Enabled at 100% sampling with invocation grouping (`observability` in
`wrangler.jsonc`), so the dashboard holds seven days of them and every line of
a run appears under the invocation that produced it.

Every line is tagged with the entry point that wrote it, which is what makes
"is the cron running at all?" a filter rather than a reading exercise:

| Tag | Written by | Says |
| --- | --- | --- |
| `[cron]` | the hourly trigger | one `starting:` line with the configuration in effect, one summary at the end |
| `[queue]` | the fetch consumers | one line per uid range: what was stored, and what was not |
| `[dlq]` | the dead-letter consumer | a range that ran out of retries |
| `[mcp]` | the fetch handler | one line per request, one per tool call |
| `[write]` | the write tools | one line per attempted write |

A healthy hour looks like this:

```
[cron] starting: imap.mail.me.com:993; folders Archive; 100 uids/range; 10 messages/fetch; ...
[queue] stored 100 messages, 4 attachments of Archive 4701:4800
[cron] Archive: 5000 uids from 4701, 50 ranges queued (uidvalidity 1, watermark 9700) — 50 ranges in 3812ms
```

The `starting:` line is there for the run that never reaches its summary — a
Worker killed at a CPU or wall-clock limit says nothing at all on its way out,
and a beginning with no end is a fact, where two silences are not.

### Turning it up

`LOG_LEVEL` is a var, so raising it does not need a redeploy: set it in the
dashboard (Settings → Variables) against the running instance, reproduce,
put it back.

```
debug   every window searched, every fetch planned, every connection timed
info    what each invocation did (the default)
warn    something is off and the run continued
error   something did not happen that should have
silent  nothing
```

`debug` is per-window and per-message, so it is loud in proportion to your
mailbox. It is the level for "the summary says the run went wrong and I need to
know where".

### What is never in a log line

The app-specific password (scrubbed in every form, on every level), message
bodies, subjects, sender addresses, and search queries. A line says how many
and how long, never what. The mailbox user is not logged either — `/status`
names it, on request, to one authenticated caller, which is a different thing
from writing it down hourly.

## When a folder stalls

`stalled: true` means rows exist above the watermark while the watermark itself
has stopped moving. The Worker is re-fetching ranges it has already fetched,
every hour, for ever, and no error is raised anywhere — which is precisely why
it needs naming.

The mechanism: work is queued by *gap detection*, which counts indexed rows per
100-uid bucket. A bucket the server returns 100 uids for but which only ever
stores 79 rows is never complete, so it is queued again next tick — and the
watermark, defined as the last uid before the first hole, cannot advance past
it.

The Worker says so itself, twice:

```
[queue] Archive: 21 of 100 uids in 4701:4800 returned no headers (4780:4800) — enumeration saw
        them, so this bucket stays short and the range is re-queued every tick until they are
        stored or stop appearing in SEARCH
[cron]  Archive: watermark still at 4700 after queueing 50 ranges — a bucket above it never
        completes, so this folder is re-queueing the same work every tick; look for uids that
        returned no headers
```

Find the failing range with a log search for `returned no headers`, then ask
the server about those uids directly (any IMAP client will do). The usual
answers:

- **The messages were expunged between the `SEARCH` and the `FETCH`.** Ordinary
  and self-healing: the next enumeration does not see them either, the bucket
  is complete at its smaller size, and the watermark moves on.
- **The server will not return them at all.** Corrupt or unfetchable mail. The
  gap is permanent, and so is the hourly re-fetch behind it.
- **Every uid in the range is unanswered.** Look at the `[queue]` lines around
  it for a connection that failed mid-range.

The cost of leaving a stall in place is not correctness — nothing is lost or
wrong — it is that the folder never goes quiet: every tick re-runs a full
enumeration and re-fetches up to `SYNC_MAX_CHUNKS_PER_RUN` ranges of mail that
is already indexed.

## Queues

The fan-out is two queues, and neither is visible from `/status` — Queues has
no binding that can be read from inside a Worker:

```bash
pnpm exec wrangler queues info imap-mcp-sync-chunks   # backlog, throughput
pnpm exec wrangler queues info imap-mcp-sync-dlq      # anything here was given up on
```

A non-empty dead-letter queue is also in the logs, tagged `[dlq]`, naming the
folder and uid range that was dropped. The recovery path is the same as for
everything else here: the next cron tick re-enumerates whatever is missing,
because gap detection asks the index rather than a cursor.

## Asking D1 directly

Everything `/status` reports comes from these tables, and sometimes the raw
question is faster:

```bash
# Where is each folder up to?
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT name, uidvalidity, uid_next, last_synced_uid,
          datetime(last_synced_at/1000,'unixepoch') AS last_run FROM folders"

# How much has landed, and when?
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT COUNT(*) AS messages, SUM(oversize) AS oversize,
          datetime(MAX(synced_at)/1000,'unixepoch') AS last_write FROM messages"

# Which buckets are short?  (the stall, located)
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT (uid-1)/100 AS bucket, COUNT(*) AS rows FROM messages
    GROUP BY bucket HAVING rows < 100 ORDER BY bucket LIMIT 20"

# What have the write tools been asked to do?
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT datetime(at/1000,'unixepoch') AS at, tool, outcome, detail
     FROM write_log ORDER BY at DESC LIMIT 20"
```

The bucket query counts in units of `SYNC_CHUNK_UIDS`; change the `100` if you
changed the var. A short bucket is not automatically a fault — mail deleted
upstream leaves one legitimately short, and gap detection compares against what
`SEARCH` returns now, not against a full hundred.

## Where configuration lives

Two places, and the split is deliberate: this repository is public, so it
commits the values that identify nobody and none of the ones that identify you.

| Value | Where it lives |
| --- | --- |
| `LOG_LEVEL`, `IMAP_PORT`, `SYNC_FOLDERS`, the sizing knobs | the `vars` block in `wrangler.jsonc`, at their defaults |
| `IMAP_HOST`, `IMAP_USER`, `SYNC_SINCE`, `DRAFT_FROM`, `DRAFTS_FOLDER`, `ACCESS_AUD` | your fork's `wrangler.jsonc`, or the dashboard |
| `IMAP_PASSWORD`, `MCP_API_KEY` | Worker secrets, never vars |

Two consequences worth knowing before they surprise you:

- **A dashboard edit to a name in the `vars` block is overwritten on the next
  deploy.** Change those in the file.
- **A dashboard edit to a name that is *not* in the block survives**, because
  `keep_vars` is set. Without it, `wrangler deploy` deletes every var it does
  not carry — and with the mailbox settings deliberately uncommittable, that
  default would mean a push silently unconfiguring your mailbox. The instance
  would keep answering `/mcp`; only the cron would stop, hourly, into logs
  nobody was reading.

`/status` reports the values actually in effect, which is where a disagreement
between the file and the dashboard shows up.

## When it is the client, not the Worker

A `401` is the same response whether the credential is wrong or Access is
misconfigured — deliberately, since telling a caller which is a hint no
legitimate client needs. The Worker logs the difference:

```
[mcp] POST /mcp -> 401 in api-key mode: no bearer token, or one that is not the API key
[mcp] POST /mcp -> 401 in access mode: ACCESS_AUD is set but the runtime supplied no Access
      context — either nothing is in front of this Worker, or the Access application does
      not cover it
[mcp] POST /mcp -> 401 in access mode: Access authenticated the caller for a different
      application than ACCESS_AUD names
```

`auth.mode` in `/status` says which credential the instance accepts at all —
worth checking first, because once `ACCESS_AUD` is set a perfectly good API key
is refused by design. [authentication.md](./authentication.md) covers the
upgrade and how to recover from a lockout (delete `ACCESS_AUD`).

A `403` instead of a `401` means the Origin check turned the request away
before authentication ran: a browser page posting at the Worker from another
site. MCP clients send no `Origin` and pass.

## Local

```bash
pnpm run dev                         # API-key mode, LOG_LEVEL from wrangler.jsonc
curl -s -H "Authorization: Bearer $(grep MCP_API_KEY .dev.vars | cut -d= -f2)" \
  http://localhost:8787/status | jq
```

`wrangler dev --test-scheduled` also exposes the cron trigger as a route, so a
tick that would otherwise be an hour away can be run now — against the local D1
and a real mailbox:

```bash
pnpm exec wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"
```
