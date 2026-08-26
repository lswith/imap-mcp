# imap-mcp

**Source-available, not a product.** This is a generic IMAP → [MCP](https://modelcontextprotocol.io) server that runs on Cloudflare Workers. It is published under MIT so the code can be read, copied and learned from — but it is built for, and run against, exactly one mailbox: a personal iCloud account. There is **no support commitment**: issues are not triaged, pull requests are not solicited, there are no releases, and nothing here is versioned for anyone else's use. If it is useful to you, fork it.

It is generic by design rather than by ambition — host, port and credentials are configuration, not constants — so it should work against any IMAP server. Only iCloud is actually exercised.

> **Status: early.** The mailbox interface ([#3](https://github.com/lswith/imap-mcp/issues/3)), the D1 schema ([#4](https://github.com/lswith/imap-mcp/issues/4)), the tracer sync ([#5](https://github.com/lswith/imap-mcp/issues/5)), the queue fan-out ([#6](https://github.com/lswith/imap-mcp/issues/6)) incremental sync ([#8](https://github.com/lswith/imap-mcp/issues/8)) the MCP server ([#7](https://github.com/lswith/imap-mcp/issues/7)), the Access gate ([#10](https://github.com/lswith/imap-mcp/issues/10)) and the retrieval tools ([#11](https://github.com/lswith/imap-mcp/issues/11)) are implemented and tested: the sync worker enumerates folders on a cron, resumes from where the last run got to, and indexes them into D1 through a queue, and the MCP server serves `search_messages`, `get_message` and `get_thread` over that index to callers Cloudflare Access has authenticated — bodies one message at a time, by id. The MCP worker still declares no route, because a route names a zone this repository does not commit — see [`docs/access.md`](./docs/access.md). See [Roadmap](#roadmap).

## What it does

Indexes a mailbox into Cloudflare's storage, then serves it to an MCP client as search and retrieval tools — so a model can answer questions against fifteen years of mail without the mailbox itself being in the loop on every query.

```
   ┌────────────────────┐  IMAP over TLS   ┌──────────────┐
   │  imap-mcp-sync     │ ───────────────▶ │   mailbox    │
   │  packages/sync     │ ◀─────────────── │   (iCloud)   │
   │  cron, owns creds  │                  └──────────────┘
   └─────────┬──────────┘
             │ writes                    ▲ writes proxied over
             ▼                           │ a service binding
   ┌────────────────────┐                │
   │  D1 (+FTS5) and R2 │                │
   └─────────┬──────────┘                │
             │ reads                     │
             ▼                           │
   ┌────────────────────┐────────────────┘   ┌──────────────┐
   │  imap-mcp-server   │  Streamable HTTP   │  MCP client  │
   │  packages/mcp      │ ◀───────────────── │  behind CF   │
   │  stateless, no creds                    │  Access      │
   └────────────────────┘                    └──────────────┘
```

Two workers, and the split between them is the security design rather than a packaging choice:

- **`packages/sync`** (`imap-mcp-sync`) is the only part of the system that speaks IMAP. It holds the app-specific password — which on iCloud grants full mailbox access *including SMTP send* — so that credential exists in exactly one place.
- **`packages/mcp`** (`imap-mcp-server`) is a stateless reader. It queries the index, never the mailbox, and proxies the few write operations back to the sync worker over a service binding rather than opening a connection of its own.

A third package, **`packages/imap`** (`@imap-mcp/imap`), is a library rather than a worker: the internal mailbox interface, and the only place the IMAP client library is imported. Only `packages/sync` depends on it.

## Quickstart

```bash
pnpm install         # installs both packages
pnpm run lint        # biome check (lint + format)
pnpm run typecheck   # wrangler types + tsc --noEmit
pnpm run test        # vitest, inside workerd
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run, both workers

pnpm run db:migrate:local    # apply migrations/ to the local D1
pnpm run db:migrate:remote   # ... and to the deployed one
```

Per package, from `packages/sync` or `packages/mcp`: `pnpm run dev`, `pnpm run test:watch`, `pnpm run deploy`.

## Configuration

This repository is public, so **no deployment-specific values are committed** — no Cloudflare account ID, no zone tag, no Cloudflare Access team domain or application audience (AUD), no mailbox address. Neither `wrangler.jsonc` contains an `account_id`, and the MCP worker declares no route at all.

Everything you would need to supply is named and explained in [`.env.example`](./.env.example). Copy it to `.env` and fill it in. In short:

| What | Where it goes |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | your environment; wrangler reads it directly |
| Route / zone for the MCP worker | `MCP_ROUTE_PATTERN` in your `.env`; generated into the deploy config |
| `ACCESS_AUD` | your `.env`; generated into a gitignored wrangler config at deploy time. **Required** — the worker answers `500` without it |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER` | `vars` in `packages/sync/wrangler.jsonc` |
| `SYNC_FOLDERS` and the four sizing vars | `vars` in `packages/sync/wrangler.jsonc`; all optional |
| `IMAP_PASSWORD` | `wrangler secret put`, sync worker only — never a `vars` entry |
| The D1 database | provisioned on first deploy; see [Storage](#storage) |
| The two queues | created by `wrangler deploy`; **Queues needs a Workers Paid plan** |

Locally, secrets go in a gitignored `.dev.vars` per package; each has a `.dev.vars.example` to copy.

### Both workers are unreachable by default

`workers_dev` and `preview_urls` are `false` in both `wrangler.jsonc` files, and the MCP worker declares no route. A fresh deploy is therefore not reachable from the internet. Without `workers_dev: false` a worker is live at `<name>.<account>.workers.dev` no matter what routes or Access policies exist — and that hostname is not one an Access application covers.

### How the MCP endpoint is authenticated

Unreachable and unauthenticated are two independent layers here, deliberately. Deleting the Access application does not silently open the endpoint, and neither does adding a route: **the worker checks Access itself** ([`packages/mcp/src/access.ts`](./packages/mcp/src/access.ts)) and answers anything Access did not authenticate for this application with a `401`.

The mechanism is Access **Managed OAuth**. Default Access answers a non-browser client with a `302` to a login page it cannot complete, which is simply a broken connection for every MCP client; Managed OAuth turns that into a spec-compliant `401` carrying a `WWW-Authenticate` header that points at the OAuth discovery endpoints, and the client runs an authorization-code flow in the user's browser.

Access is attached to the **Worker**, not to a hostname, so it covers every route, Custom Domain and `workers.dev` URL the Worker ever has rather than one exact URL. That makes `workers_dev: false` defence in depth rather than the only thing holding the line — and it is why the workers are deployed *before* the Access application exists, since you cannot attach a Worker that does not.

One detail of it shapes the implementation. The token the **client** ends up holding is *opaque* (`oauth:…`) and cannot be verified by anyone but Access — the worker never sees it. What the worker sees is [`ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), which the Workers runtime populates for a request Access authenticated.

Reading the runtime rather than a header is the stronger of the two options, not merely the newer one. A header is request data, trustworthy only for as long as nothing can reach the worker without traversing Access; `ctx.access` cannot be spoofed by a caller at all, and is simply absent when Access did not run — so the gate closes on exactly the case a header check would have to reason about.

What it still has to check is the **audience**: `ctx.access.aud` must match this application's tag. Access authenticating *someone* is not the same claim as Access authenticating them for *this* application, and one Zero Trust account can hold many — another of which may have a far more generous policy.

Missing configuration fails closed: with `ACCESS_AUD` unset the worker answers `500`, never an unauthenticated `200`.

[`docs/access.md`](./docs/access.md) is the setup guide, and [`scripts/setup-access.sh`](./scripts/setup-access.sh) walks it interactively. Note that the MCP worker is not deployed on its own: `imap-mcp-sync` goes first, because it provisions the D1 database both workers share — see [First deploy](#first-deploy). A full deploy-from-scratch guide — secrets, bindings, migrations and the backfill — is [#13](https://github.com/lswith/imap-mcp/issues/13); the Access half is written.

**No committed file is edited to deploy.** `pnpm run deploy` runs [`scripts/deploy-config.mjs`](./scripts/deploy-config.mjs) first, which merges your `.env` into a copy of the committed `wrangler.jsonc` and writes it under the gitignored `.wrangler/`, using wrangler's [redirected configuration](https://developers.cloudflare.com/workers/wrangler/configuration/). The audience tag, the route and the `database_id` wrangler writes back therefore all stay out of git — "nothing deployment-specific is committed" becomes a mechanism rather than a promise, and no private fork is needed to run this against your own account. With no `.env` the script no-ops and wrangler reads the committed config, exactly as a fresh clone does.

## Storage

One D1 database, written by the sync worker and read by the MCP server. The
schema is at [`migrations/`](./migrations) in the repo root — shared, rather
than owned by either worker — and both `wrangler.jsonc` files point their
`migrations_dir` at it.

| | |
| --- | --- |
| `folders` | one row per mailbox, carrying `uidvalidity` and the sync watermark |
| `messages` | envelope fields plus the normalised plain-text body |
| `attachments` | metadata and the R2 key; the bytes live in R2. Nothing writes it until [#9](https://github.com/lswith/imap-mcp/issues/9), so `get_message` reports the flag and says the list is unavailable rather than reporting "none" |
| `write_log` | every mailbox write, successful or not |
| `messages_fts` | FTS5 over subject and body, BM25-ranked |

Two things in that schema are load-bearing rather than incidental:

- **The plain-text body is a real column, not just FTS index content.** That is
  the seam that lets semantic search be added later by reading this database,
  instead of re-pulling fifteen years of mail from iCloud.
- **Messages are keyed on `(folder, uidvalidity, uid)`**, so every write is an
  upsert. Queue delivery is at-least-once and consumers have to be safe to
  re-run. `UIDPLUS` is available on iCloud and every `APPEND` returns an
  APPENDUID, so that key comes back from the server on each write rather than
  needing a re-fetch to discover.

`messages_fts` is an FTS5 **external content** table: it indexes `messages`
rather than holding a second copy of every body, and three triggers keep it in
step so no write path can forget to reindex. Its tokenizer is
`porter unicode61 remove_diacritics 2` — stemmed, so "meeting" finds
"meetings", and diacritic-folded, so "cafe" finds "café". One known limitation,
pinned by a test rather than left to be rediscovered: `unicode61` does not
word-segment CJK, so a run like 会議は月曜日です indexes as a single token. It
stores and reads back exactly; it is keyword search over it that is coarse, and
a prefix query (`会議*`) is the way through.

### There is no database export

**`wrangler d1 export` refuses to run against any database containing an FTS5
virtual table**, and this one has `messages_fts`. So there is no working export
of this database, and no backup taken that way. **Re-running the backfill is the
recovery path** — which is affordable precisely because the mailbox, not D1, is
the source of truth: everything here is derived and can be rebuilt from IMAP.

### First deploy

Neither `wrangler.jsonc` commits a `database_id`. A database id identifies one
Cloudflare account, and this repository commits no account-specific values — so
the binding declares `database_name` and nothing else, and wrangler
[provisions it](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning):
`wrangler dev` creates it locally, `wrangler deploy` creates it on your account,
binds it, and writes the id back into your copy of the config. It is also what a
"Deploy to Cloudflare" button would do.

Two things follow. **Both workers must end up on the same database** — deploy
`imap-mcp-sync` first, then point `imap-mcp-server` at the database that deploy
created rather than letting it provision a second one. And **the id wrangler
writes back lands in a committed file**; it is yours, so don't push it upstream.

Then apply the schema with `pnpm run db:migrate:remote`. Re-running it is a
no-op — applied migrations are recorded in a `d1_migrations` table.

## What the sync worker does

Once an hour, `imap-mcp-sync` connects and **enumerates**: it opens each
configured folder read-only, lists UIDs — identifiers only, no bodies — and
posts them to a Cloudflare Queue in ranges of about a hundred. A **consumer**
then takes one range per invocation, fetches it over a single IMAP connection,
reduces each message to a row and upserts it into D1.

Three numbers in that shape are load-bearing:

- **A queue message is a UID range, never a single email.** One message per
  email would mean one TCP + TLS + `LOGIN` + `SELECT` per email — tens of
  thousands of logins for a backfill, which Apple will throttle or lock long
  before it finishes. Ranges of ~100 turn that into a few hundred.
- **Consumer concurrency is capped at 4.** Queues will autoscale to hundreds of
  parallel consumers, but D1 is a single Durable Object and single-threaded, so
  high fan-out only relocates the bottleneck — while opening hundreds of
  connections to one Apple account at the same time.
- **A cron tick queues at most 50 ranges.** That is the throttle on a backfill:
  roughly five thousand messages an hour, and a large folder therefore
  completes over several ticks rather than all at once.

What gets queued is decided by looking for gaps rather than by advancing a
cursor: one query asks D1 how many messages are already indexed in each UID
bucket, and only the buckets that come up short are enqueued. A folder
converges — each run queues what is still missing and then goes quiet — and a
range that runs out of retries is picked up again on the next tick instead of
being stepped over for good.

**A run resumes rather than restarts.** Each folder carries a watermark: the
highest UID below the first gap, which is the most that can honestly be claimed
when ranges complete out of order under fan-out. The next run walks from above
it, and asks D1 about the buckets above it too — matching the two is a
correctness requirement rather than a saving, because the bucket straddling the
watermark also holds rows below it. When the watermark reaches the top of a
folder's UID space the folder is skipped without a single `SEARCH`, which is
what makes a quiet hourly tick cheap rather than merely convergent. Against the
real mailbox that is the difference between about eight seconds and about two.

Two discontinuities are handled rather than assumed away. A changed
`UIDVALIDITY` means every UID recorded for that folder now identifies a
different message, so the watermark is dropped and the folder re-indexes from
UID 1 — the old rows stay addressable under their own `uidvalidity` while that
happens. And a folder **deleted or renamed upstream** is skipped with a warning
instead of failing the run: one `LIST` per run tells the difference, because a
tagged `NO` on `SELECT` looks the same either way, and ranges already in flight
for that folder are dropped rather than spending three retries on their way to
the dead-letter queue.

`CONDSTORE` is enabled for the session, which has to happen in the
authenticated state before the first `SELECT` — RFC 5161 requires that ordering
and getting it wrong is silent, since the only symptom is that `HIGHESTMODSEQ`
never appears. So support is detected by that value arriving, never by the
`ENABLE` reply, which iCloud returns empty while plainly having enabled it.
Nothing reads a mod-sequence yet; recording it per folder is what
[#24](https://github.com/lswith/imap-mcp/issues/24) starts from.

**Enumeration uses UID ranges and dates, and nothing else.** A spike ran sixteen
`SEARCH` criteria against a real iCloud folder: `ALL`, `SINCE`/`BEFORE` and the
flag criteria are exact, but `LARGER` matches *everything*, `SMALLER` matches
*nothing* whatever argument they are given, and every string criterion —
`SUBJECT`, `TEXT`, `HEADER Subject`, even `FROM "@"` — returns zero hits.
Whether that is iCloud or the client was never isolated, and the design does not
depend on the answer.

Five properties of a run are deliberate, and each is pinned by a test rather
than left as an intention:

- **Nothing it does can change the mailbox.** Folders are opened with
  `EXAMINE`, every fetch `PEEK`s — the internal `Mailbox` interface has no way
  to fetch without it — and indexing therefore cannot mark mail as read.
- **Redelivering a range writes no duplicate rows.** Every message write is an
  upsert on `(folder_id, uidvalidity, uid)`, so the same range can be covered
  again after a failure, a redeploy, or the at-least-once delivery a queue
  guarantees.
- **An authentication failure aborts loudly and does not retry.** A revoked
  app-specific password retried on every tick — or, worse, across every
  consumer at once — is how an Apple ID gets locked, so that failure and a
  missing setting stop the run. On the cron path that means `noRetry()`; on the
  queue path the batch is acked rather than retried, and the next tick
  re-enumerates whatever it did not store. Ordinary failures retry.
- **A range that exhausts its retries lands on a dead-letter queue**, which is
  read and logged with the folder and UID range it was carrying — so what was
  missed is a line you can look at rather than a silent hole.
- **The credential never reaches a log line.** Every line this worker logs is
  scrubbed of the password in all the forms it could come back off the wire —
  plaintext, quoted, and SASL base64 — including error paths.

Bodies are normalised on the way in, because that is what gets indexed and,
eventually, read by a model. HTML is reduced to plain text with a real parser
(`HTMLRewriter`), `<script>` and `<style>` go with it, and so does anything a
reader could not have seen: `hidden`, `aria-hidden`, `display: none`,
`font-size: 0`. Then the characters that exist to hide text from a human —
zero-width spaces, bidi overrides, the Unicode tag block — are stripped, after
character references are decoded rather than before, so that a zero-width space
written as `&#8203;` is caught too.

## What the MCP server does

Three read tools, meant to be used in that order: `search_messages` finds
candidates, `get_thread` shows the conversation one of them sits in, and
`get_message` reads the ones that turn out to matter. All three read D1 and
nothing else — no IMAP connection, no mailbox credential, no live mailbox in the
serving path.

The ordering is the design rather than a suggestion. Every subject, snippet and
body in this database was written by whoever sent the mail, which is to say by
anyone, and it sits one tool call away from the write tools ([#12](https://github.com/lswith/imap-mcp/issues/12)).
So **bodies leave one at a time, by an id the caller had to be given**: search
returns snippets and never a body, a thread returns identity and an
800-character preview per message and never a body, and `get_message` returns
exactly one, truncated at 16 000 characters. None of those caps is a parameter,
and neither retrieval tool takes an offset — paging would be a second way to
reassemble in bulk what the cap just refused.

Everything message-derived is returned inside a marked envelope, and the
closing tag carries a **nonce drawn fresh per response**. A fixed delimiter is a
fixed string and a subject written months ago can contain it; a nonce cannot be
known when the message was sent, so the closing tag is the one part of the
output an author cannot produce. It is also drawn against the text it is about
to frame and redrawn on collision, which is cheap and removes the last
"astronomically unlikely" from the argument. What that buys is an honest
boundary — not immunity to the instructions inside it, which is the warning's
job and ultimately the model's.

Subjects, snippets, previews and filenames are collapsed to one line, because
those are rendered as list rows and a newline would let a message add rows to
the list it appears in. A body is not a row — it is one region between two tags,
so there is nothing for a newline to forge and collapsing it would make the tool
useless. Serving one at all is only defensible because the body was normalised
at index time: the HTML is already reduced, hidden elements dropped, and
zero-width and bidi characters stripped.

**Threads are reconstructed here, not asked for.** There is no `thread_id` and
no IMAP `THREAD` command in the picture: a conversation is derived from
Message-ID, In-Reply-To and References. RFC 5322 makes a conformant reply carry
its parent's whole ancestry, so one query reaches ancestors, siblings and
descendants at once. When those headers link nothing at all — plenty of clients
strip them — it falls back to a matching subject within 30 days, bounded by a
minimum subject length and re-checked exactly in TypeScript, and **the answer
says which of the two happened**, because a subject match is a guess and should
read as one. The database query behind that fallback is anchored at the end of
the subject rather than searching anywhere inside it: the prefixes replies add
are prefixes, so a suffix test keeps every reply form while refusing the
unrelated mail that merely starts the same way — which would otherwise be able
to crowd the genuine replies out of the answer. A message filed in several folders comes back once per copy rather
than collapsed, since each copy is a different message on the server and that
triple is what the write tools will act on.

## Roadmap

Tracked as [issues on this repo](https://github.com/lswith/imap-mcp/issues):

| | |
| --- | --- |
| [#2](https://github.com/lswith/imap-mcp/issues/2) | Repo scaffold — *this* |
| [#3](https://github.com/lswith/imap-mcp/issues/3) | The IMAP client, behind an internal interface |
| [#4](https://github.com/lswith/imap-mcp/issues/4) | D1 schema and migrations |
| [#5](https://github.com/lswith/imap-mcp/issues/5) | Tracer: sync one folder into D1 — *done* |
| [#6](https://github.com/lswith/imap-mcp/issues/6) | Queue fan-out for the sync path — *done* |
| [#7](https://github.com/lswith/imap-mcp/issues/7) | MCP server and `search_messages` — *done* |
| [#8](https://github.com/lswith/imap-mcp/issues/8) | Incremental sync: watermarks and `UIDVALIDITY` — *done* |
| [#9](https://github.com/lswith/imap-mcp/issues/9) | Attachments to R2, with text extraction |
| [#10](https://github.com/lswith/imap-mcp/issues/10) | Gate the MCP endpoint with Access Managed OAuth — *done* |
| [#11](https://github.com/lswith/imap-mcp/issues/11) | `get_message` and `get_thread` — *done* |
| [#12](https://github.com/lswith/imap-mcp/issues/12) | Write tools over a service binding, with an audit log |
| [#13](https://github.com/lswith/imap-mcp/issues/13) | Full backfill and setup guide |
| [#24](https://github.com/lswith/imap-mcp/issues/24) | Flag reconciliation over CONDSTORE |

A spike settled the one question the whole architecture was contingent on — **can a Cloudflare Worker speak IMAP to iCloud at all?** It can: TLS and `LOGIN` on port 993 in 755 ms, folders listed, messages fetched and MIME-decoded, a draft appended and flagged. So the sync path is a Worker and nothing moves to a Container. The findings that constrain the design — CONDSTORE ordering, no `MOVE` on iCloud, `SEARCH` being unusable for content — are written into the tickets they affect.

## Licence

MIT — see [LICENSE](./LICENSE).

### The IMAP client

The protocol client is [`cf-imap`](https://github.com/Exerra/cf-imap) by Exerra
([npm](https://www.npmjs.com/package/cf-imap)), MIT licensed — *Copyright (c)
2024 Exerra*, `LICENSE` in the published tarball. It has zero runtime
dependencies.

Note for anyone running a licence scanner over this repo: no published version
of `cf-imap` sets a `license` **field** in its `package.json`, so scanners
report it as unlicensed. The MIT text does ship inside the tarball — it is a
metadata gap, not an absent licence.

Issue [#3](https://github.com/lswith/imap-mcp/issues/3) weighed vendoring the
source against depending on the package and settled on depending. The
generic-by-design requirement is met by the interface instead:
`packages/imap/src/types.ts` is what the rest of the repo is written against,
and `cf-imap` is imported in exactly one file
(`packages/imap/src/cf-imap-mailbox.ts`), so swapping the client — or the
provider — is a change to that file rather than a refactor.

What depending rather than vendoring costs is that four behaviours of the
pinned version are worked around or pinned by tests rather than fixed at the
source. None is reported upstream yet:

| Behaviour | Effect here |
| --- | --- |
| `storeFlags` cannot parse the `MODSEQ (n)` RFC 7162 §3.1.3 requires on untagged `FETCH` once CONDSTORE is enabled | a flag write that lands reports zero rows, so `setFlags` discards the `STORE` response and verifies every write with an independent `UID FETCH` |
| every `iso-8859-*` charset is decoded as ISO-8859-1, ahead of the `TextDecoder` fallback | ISO-8859-15's euro sign arrives as a currency sign; pinned in `packages/imap/test/protocol/mime.test.ts` |
| a `FETCH` literal is decoded as UTF-8 before the part's charset is known | bodies sent as raw 8-bit (`Content-Transfer-Encoding: 8bit`) lose their non-ASCII characters; anything quoted-printable or base64 is unaffected. Pinned in the same file |
| the published ESM uses extensionless relative imports | bundlers (workerd, `wrangler deploy`) resolve them; Node's ESM resolver does not, so the Node-side test project has Vite process the package instead |

The tests that pin these are contract tests over a pinned dependency: they are
what turns an upgrade, or a swap to another client, into a red build rather
than a quiet change in what fifteen years of mail decodes to.
