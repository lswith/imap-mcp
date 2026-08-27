# Architecture

How imap-mcp works and why it is shaped this way. This is the design essay;
the [README](../README.md) is the landing page, [deploy.md](./deploy.md) gets
you to a working instance, and [authentication.md](./authentication.md) covers
the two ways callers are let in.

## What it does

Indexes a mailbox into Cloudflare's storage, then serves it to an MCP client as
search and retrieval tools — so a model can answer questions against fifteen
years of mail without the mailbox itself being in the loop on every query.

```
                        ┌─────────────────────────────┐
     IMAP over TLS      │  imap-mcp (one Worker)      │
   ┌──────────────┐     │                             │
   │   mailbox    │ ◀──▶│  sync half   src/sync       │
   │   (iCloud)   │     │  cron + queues, owns creds  │
   └──────────────┘     │      │ writes    ▲ writes,  │
                        │      ▼           │ audited  │
                        │  ┌──────────────────┐       │
                        │  │ D1 (+FTS5), R2   │       │
                        │  └──────┬───────────┘       │
                        │         │ reads             │
                        │         ▼                   │      ┌──────────────┐
                        │  MCP half    src/mcp        │◀────▶│  MCP client  │
                        │  auth gate, tools, audit    │ HTTP │              │
                        └─────────────────────────────┘      └──────────────┘
```

One Worker, three entry points: `fetch` serves the MCP endpoint, `scheduled`
enumerates the mailbox on a cron, and a queue consumer fetches message ranges.
Inside it, the halves keep a deliberate seam:

- **`src/sync`** is the only part of the system that speaks IMAP. It holds the
  app-specific password — which on iCloud grants full mailbox access
  *including SMTP send* — and every refusal a write can meet lives here, with
  the credential.
- **`src/mcp`** is a stateless reader. It queries the index, never the mailbox,
  and hands write requests to the sync half through one typed interface
  (`WriteService`, `src/writes.ts`), recording every attempt in an audit log.
- **`src/imap`** is the internal mailbox interface, and the only place the IMAP
  client library is imported — enforced by a lint rule, so swapping the client
  or the provider stays a change to one file.

### Why one Worker

This used to be two Workers: the sync worker held the credential, and the
internet-facing MCP worker held none, with writes proxied across a service
binding. That boundary read well and protected less than it appeared to: it
kept the credential away from the system's best-audited dependencies while the
least-audited one — the protocol client — already shared an isolate with it.
The split's real costs were a monorepo, a deploy-ordering hazard (two workers
that had to land on the *same* D1 database, with nothing enforcing it), and no
possibility of a one-click deploy, since Cloudflare requires a deploy target to
be self-contained and will not deploy two Workers from one repository.

So [#34](https://github.com/lswith/imap-mcp/issues/34) merged them. The
supply-chain risk the split defended against is addressed at install time
instead: pnpm enforces a **four-day minimum release age** on every dependency
(`pnpm-workspace.yaml`), giving a compromised release time to be discovered and
pulled before this repo adopts it. What survives the merge is the property that
mattered — the protocol client is importable in exactly one file, and every
write is policy-checked in the mailbox layer and audited in the tool layer.

## What the MCP server serves

Six tools: three reads over the index, three writes that reach the mailbox
through the write service — the MCP half opens no IMAP connection of its own.

| | |
| --- | --- |
| `search_messages` | keyword search over the index. Snippets and ids; never a body |
| `get_message` | one whole message, by id, capped and framed |
| `get_thread` | the conversation around a message; previews, never bodies |
| `flag_message` | set or clear `\Seen`, `\Flagged`, `\Answered` |
| `move_message` | move one message to another folder |
| `create_draft` | save a draft to Drafts, optionally threaded as a reply |

**There is no send and no delete, and that is structural rather than a
policy.** This system contains no SMTP client at all. `\Deleted` is not a flag
`flag_message` will set — it is written in exactly one function, over exactly
one uid, immediately after that uid has been copied somewhere else, and only
once the server has confirmed the copy. Everything these tools can do is
reversible: flags flip back, a move can be moved back, and a draft is a file
you delete.

Three narrower limits do the rest of the work:

- **Trash and Junk are refused as move destinations**, by name *and* by
  special-use attribute — iCloud does not reliably advertise `\Trash`, so a
  check that trusted attributes alone would pass a folder plainly called
  Trash. Every other folder is allowed, so the worst a smuggled instruction
  achieves is misfiling something you can find again.
- **Every write is recorded in `write_log`**, with the identity of the caller
  (when Access provides one), the arguments as the model supplied them, and
  the outcome — including writes that failed, and writes refused before the
  mailbox was contacted at all. The row is written *before* the attempt and
  updated after it, so a Worker that dies mid-write leaves a record saying so
  rather than nothing. This is the control that actually matters: it turns
  hidden mischief into a list you can look at.
- **Every write is checked against `UIDVALIDITY` before it happens.** A folder
  that has been renumbered since the search that produced the id has every uid
  pointing at a different message; search merely hides those rows, but a write
  has to refuse them.

iCloud offers no `MOVE` — it is absent from `CAPABILITY`, and the session is
`IMAP4rev1` — so `move_message` is `COPY`, then `STORE \Deleted`, then
**`UID EXPUNGE`**. Each step gates the next, and the last one is not
negotiable: a bare `EXPUNGE` sweeps *every* `\Deleted` message in the folder,
including ones another mail client marked and has not yet expunged. The
internal `Mailbox` interface has no bare-`EXPUNGE` path at all, so there is
nothing to remember.

A move is the one write that changes the index directly: the source row is
deleted, because after the expunge its uid addresses nothing and neither
incremental sync nor flag reconciliation detects an expunge. Flag changes are
not written back — the mailbox is the source of truth and
[#24](https://github.com/lswith/imap-mcp/issues/24) reconciles them, so until
it ships a flag set through the tool is not visible to `search_messages`.

## Storage

One D1 database, written by the sync half and read by the MCP half. The schema
is at [`migrations/`](../migrations).

| | |
| --- | --- |
| `folders` | one row per mailbox, carrying `uidvalidity` and the sync watermark |
| `messages` | envelope fields plus the normalised plain-text body |
| `attachments` | metadata and the R2 key; the bytes live in R2 |
| `write_log` | every mailbox write, successful or not |
| `messages_fts` | FTS5 over subject and body, BM25-ranked |
| `attachments_fts` | FTS5 over attachment filenames and extracted text |

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

### Attachments

Attachment bytes go to **R2**, with a metadata row in `attachments` pointing at
them. They cannot go in D1 — its per-value limit is 2 MB — but the reason they
are pulled during sync rather than on demand is a security decision: fetching
on demand would put a live IMAP connection on the read path, one tool call away
from attacker-written text. R2 at about $0.015/GB-month makes storing
everything the cheap option as well as the safe one.

The key is **derived, not generated**: `att/<folder>/<uidvalidity>/<uid>/<part>`.
So re-syncing a message overwrites its objects instead of duplicating them, with
no bookkeeping to keep in step, and a folder that changed its `UIDVALIDITY`
writes a new generation alongside the old rather than over it. Inline parts — the
signature logos and embedded images — are stored like any other, with `is_inline`
recorded so a reader can tell them apart.

**Text is extracted for `.txt`, `.md` and `.csv`, and for nothing else.** PDF and
`.docx` are stored and retrievable but **not indexed**: there is no good
Workers-native PDF parser, and `.docx` needs a zip reader this does not have yet
([#31](https://github.com/lswith/imap-mcp/issues/31)). For those, the filename is
the only thing there is to search on, which is why `attachments_fts` indexes it
alongside the text. That gap is also the single best justification for moving the
sync path into a Cloudflare Container later; PDF extraction would ride along.

An attachment that cannot be decoded is **not a failed message**. Its row is
written with a null `r2_key` and a warning is logged, so a message that lost an
attachment says so rather than looking like a message that never had one. A
failure to *store* is different and does fail the range, which is deliberate:
the bytes are written before the D1 row, so a failed write leaves no message row
either, the uid bucket stays short, and gap detection queues the range again.
The order is the mechanism — a row that could land while its bytes did not would
mark the bucket complete for good.

### Fetching a message has a size ceiling

`cf-imap` materialises every attachment **twice** — decoded and base64 — on top
of the whole raw message held as a string, and offers no streaming API. A spike
measured a small `text/calendar` part at 3,377 bytes on the wire holding 8,585
bytes resident, 2.54×, and that is a *small text* attachment. So a big enough
message does not fail to fetch; it exhausts the isolate.

The ceiling is therefore decided before any bytes move. Each range gets one
**header-only `FETCH`** first, which answers `RFC822.SIZE` for every uid in it
for the cost of a few hundred bytes each. That one number does two jobs: it
decides which messages can be fetched at all, and it groups the rest into
fetches bounded by bytes as well as by count, so ten ordinary messages still
travel together and a single 6 MB one travels alone. `SYNC_MAX_FETCH_BYTES`
(default 8 MiB) is both bounds at once, because the worst case either way is one
message of that size in flight.

A message above it is **recorded from its headers and never body-fetched**: the
row carries `oversize = 1`, no body, no attachments, and no `In-Reply-To` or
`References` either, since a header-only fetch does not ask for them. A row
rather than nothing, because gap detection counts rows — skipping the message
outright would leave its bucket permanently short and re-queue the range on
every tick forever.

### There is no database export

**`wrangler d1 export` refuses to run against any database containing an FTS5
virtual table**, and this one has `messages_fts`. So there is no working export
of this database, and no backup taken that way. **Re-running the backfill is the
recovery path** — which is affordable precisely because the mailbox, not D1, is
the source of truth: everything here is derived and can be rebuilt from IMAP.

## What the sync half does

Once an hour, the cron entry point connects and **enumerates**: it opens each
configured folder read-only, lists UIDs — identifiers only, no bodies — and
posts them to a Cloudflare Queue in ranges of about a hundred. A **consumer**
then takes one range per invocation, reads every message's size over a single
IMAP connection, fetches the ones that fit, reduces each to a row and upserts it
into D1 — with any attachment bytes written to R2 first.

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
- **The credential never reaches a log line.** Every line the sync half logs is
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

## What the MCP half does

Three read tools, meant to be used in that order: `search_messages` finds
candidates, `get_thread` shows the conversation one of them sits in, and
`get_message` reads the ones that turn out to matter. All three read D1 and
nothing else — no IMAP connection in the serving path, no live mailbox in the
loop.

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
strip them — the answer is the message you asked for and a note saying why:
no message names it and none is named by it, and mail from such a client cannot
be threaded from this index. There was a subject-matching fallback here and it
was removed rather than repaired. It could not be made correct — the exact
comparison has to happen outside SQL, so the query that narrowed always let
through subjects the comparison would reject, and anything a row limit cut was
never compared at all — and what it bought was a grouping that had to describe
itself as a guess. A short answer that is true beats a long one that might be.

## The IMAP client

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
`src/imap/types.ts` is what the rest of the repo is written against, and
`cf-imap` is imported in exactly one file (`src/imap/cf-imap-mailbox.ts`), so
swapping the client — or the provider — is a change to that file rather than a
refactor.

What depending rather than vendoring costs is that four behaviours of the
pinned version are worked around or pinned by tests rather than fixed at the
source. Filing them upstream is
[#40](https://github.com/lswith/imap-mcp/issues/40):

| Behaviour | Effect here |
| --- | --- |
| `storeFlags` cannot parse the `MODSEQ (n)` RFC 7162 §3.1.3 requires on untagged `FETCH` once CONDSTORE is enabled | a flag write that lands reports zero rows, so `setFlags` discards the `STORE` response and verifies every write with an independent `UID FETCH` |
| every `iso-8859-*` charset is decoded as ISO-8859-1, ahead of the `TextDecoder` fallback | ISO-8859-15's euro sign arrives as a currency sign; pinned in `test/imap/protocol/mime.test.ts` |
| a `FETCH` literal is decoded as UTF-8 before the part's charset is known | bodies sent as raw 8-bit (`Content-Transfer-Encoding: 8bit`) lose their non-ASCII characters; anything quoted-printable or base64 is unaffected. Pinned in the same file |
| the published ESM uses extensionless relative imports | bundlers (workerd, `wrangler deploy`) resolve them; Node's ESM resolver does not, so the Node-side test project has Vite process the package instead |

The tests that pin these are contract tests over a pinned dependency: they are
what turns an upgrade, or a swap to another client, into a red build rather
than a quiet change in what fifteen years of mail decodes to.

A spike settled the one question the whole architecture was contingent on —
**can a Cloudflare Worker speak IMAP to iCloud at all?** It can: TLS and
`LOGIN` on port 993 in 755 ms, folders listed, messages fetched and
MIME-decoded, a draft appended and flagged. So the sync path is a Worker and
nothing moves to a Container. The findings that constrain the design —
CONDSTORE ordering, no `MOVE` on iCloud, `SEARCH` being unusable for content —
are written into the tickets they affect.
