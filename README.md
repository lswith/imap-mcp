# imap-mcp

**Source-available, not a product.** This is a generic IMAP → [MCP](https://modelcontextprotocol.io) server that runs on Cloudflare Workers. It is published under MIT so the code can be read, copied and learned from — but it is built for, and run against, exactly one mailbox: a personal iCloud account. There is **no support commitment**: issues are not triaged, pull requests are not solicited, there are no releases, and nothing here is versioned for anyone else's use. If it is useful to you, fork it.

It is generic by design rather than by ambition — host, port and credentials are configuration, not constants — so it should work against any IMAP server. Only iCloud is actually exercised.

> **Status: early.** The mailbox interface ([#3](https://github.com/lswith/imap-mcp/issues/3)) and the D1 schema ([#4](https://github.com/lswith/imap-mcp/issues/4)) are implemented and tested. Both workers are still placeholders: nothing syncs and nothing is served yet. See [Roadmap](#roadmap).

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
| Route / zone for the MCP worker | a `routes` entry you add to `packages/mcp/wrangler.jsonc` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | `vars` in `packages/mcp/wrangler.jsonc` |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER` | `vars` in `packages/sync/wrangler.jsonc` |
| `IMAP_PASSWORD` | `wrangler secret put`, sync worker only — never a `vars` entry |
| The D1 database | provisioned on first deploy; see [Storage](#storage) |

Locally, secrets go in a gitignored `.dev.vars` per package; each has a `.dev.vars.example` to copy.

### Both workers are unreachable by default

`workers_dev` and `preview_urls` are `false` in both `wrangler.jsonc` files, and the MCP worker declares no route. A fresh deploy is therefore not reachable from the internet. This is deliberate: with no folder fence, the MCP endpoint is functionally read access to an entire mailbox, so it must not become reachable before Cloudflare Access is in front of it. Without `workers_dev: false` a worker is live at `<name>.<account>.workers.dev` no matter what routes or Access policies exist.

A full deploy-from-scratch guide — secrets, Access setup, bindings, migrations and the backfill — is not written yet; it lands with the rest of the system.

## Storage

One D1 database, written by the sync worker and read by the MCP server. The
schema is at [`migrations/`](./migrations) in the repo root — shared, rather
than owned by either worker — and both `wrangler.jsonc` files point their
`migrations_dir` at it.

| | |
| --- | --- |
| `folders` | one row per mailbox, carrying `uidvalidity` and the sync watermark |
| `messages` | envelope fields plus the normalised plain-text body |
| `attachments` | metadata and the R2 key; the bytes live in R2 |
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

## Roadmap

Tracked as [issues on this repo](https://github.com/lswith/imap-mcp/issues):

| | |
| --- | --- |
| [#2](https://github.com/lswith/imap-mcp/issues/2) | Repo scaffold — *this* |
| [#3](https://github.com/lswith/imap-mcp/issues/3) | The IMAP client, behind an internal interface |
| [#4](https://github.com/lswith/imap-mcp/issues/4) | D1 schema and migrations |
| [#5](https://github.com/lswith/imap-mcp/issues/5) | Tracer: sync one folder into D1 |
| [#6](https://github.com/lswith/imap-mcp/issues/6) | Queue fan-out for the sync path |
| [#7](https://github.com/lswith/imap-mcp/issues/7) | MCP server and `search_messages` |
| [#8](https://github.com/lswith/imap-mcp/issues/8) | Incremental sync: watermarks and `UIDVALIDITY` |
| [#9](https://github.com/lswith/imap-mcp/issues/9) | Attachments to R2, with text extraction |
| [#10](https://github.com/lswith/imap-mcp/issues/10) | Gate the MCP endpoint with Access Managed OAuth |
| [#11](https://github.com/lswith/imap-mcp/issues/11) | `get_message` and `get_thread` |
| [#12](https://github.com/lswith/imap-mcp/issues/12) | Write tools over a service binding, with an audit log |
| [#13](https://github.com/lswith/imap-mcp/issues/13) | Full backfill and setup guide |

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
