# imap-mcp

**Source-available, not a product.** This is a generic IMAP → [MCP](https://modelcontextprotocol.io) server that runs on Cloudflare Workers. It is published under MIT so the code can be read, copied and learned from — but it is built for, and run against, exactly one mailbox: a personal iCloud account. There is **no support commitment**: issues are not triaged, pull requests are not solicited, there are no releases, and nothing here is versioned for anyone else's use. If it is useful to you, fork it.

It is generic by design rather than by ambition — host, port and credentials are configuration, not constants — so it should work against any IMAP server. Only iCloud is actually exercised.

> **Status: scaffold.** Nothing functional is implemented yet. Both workers are placeholders that install, lint, typecheck, test and pass a deploy dry-run. See [Roadmap](#roadmap).

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

## Quickstart

```bash
pnpm install         # installs both packages
pnpm run lint        # biome check (lint + format)
pnpm run typecheck   # wrangler types + tsc --noEmit
pnpm run test        # vitest, inside workerd
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run, both workers
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

Locally, secrets go in a gitignored `.dev.vars` per package; each has a `.dev.vars.example` to copy.

### Both workers are unreachable by default

`workers_dev` and `preview_urls` are `false` in both `wrangler.jsonc` files, and the MCP worker declares no route. A fresh deploy is therefore not reachable from the internet. This is deliberate: with no folder fence, the MCP endpoint is functionally read access to an entire mailbox, so it must not become reachable before Cloudflare Access is in front of it. Without `workers_dev: false` a worker is live at `<name>.<account>.workers.dev` no matter what routes or Access policies exist.

A full deploy-from-scratch guide — secrets, Access setup, bindings, migrations and the backfill — is not written yet; it lands with the rest of the system.

## Roadmap

Tracked as issues on [`lswith/lswith.io`](https://github.com/lswith/lswith.io/issues) rather than here, since the plan predates this repository:

| | |
| --- | --- |
| [#127](https://github.com/lswith/lswith.io/issues/127) | Spike: prove IMAP works from a Worker — **answered, GO** |
| [#128](https://github.com/lswith/lswith.io/issues/128) | Repo scaffold — *this* |
| [#129](https://github.com/lswith/lswith.io/issues/129) | Vendor the IMAP client behind an internal interface |
| [#130](https://github.com/lswith/lswith.io/issues/130) | D1 schema and migrations |
| [#131](https://github.com/lswith/lswith.io/issues/131) | Tracer: sync one folder into D1 |
| [#132](https://github.com/lswith/lswith.io/issues/132) | Queue fan-out for the sync path |
| [#133](https://github.com/lswith/lswith.io/issues/133) | MCP server and `search_messages` |
| [#134](https://github.com/lswith/lswith.io/issues/134) | Incremental sync: watermarks and `UIDVALIDITY` |
| [#135](https://github.com/lswith/lswith.io/issues/135) | Attachments to R2, with text extraction |
| [#136](https://github.com/lswith/lswith.io/issues/136) | Gate the MCP endpoint with Access Managed OAuth |
| [#137](https://github.com/lswith/lswith.io/issues/137) | `get_message` and `get_thread` |
| [#138](https://github.com/lswith/lswith.io/issues/138) | Write tools over a service binding, with an audit log |
| [#139](https://github.com/lswith/lswith.io/issues/139) | Full backfill and setup guide |

## Licence

MIT — see [LICENSE](./LICENSE).
