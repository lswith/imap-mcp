# imap-mcp

A generic IMAP → [MCP](https://modelcontextprotocol.io) server on Cloudflare
Workers. It indexes a mailbox into Cloudflare's storage on a cron, then serves
it to an MCP client as search, retrieval and narrow write tools — so a model
can answer questions against fifteen years of mail without the mailbox itself
being in the loop on every query.

Contributions are welcome; there is no support commitment. The project is run
against one personal iCloud mailbox, and it is generic by design rather than by
ambition — host, port and credentials are configuration, not constants — with
a second provider (Gmail, [#42](https://github.com/lswith/imap-mcp/issues/42))
on the way to being exercised. Deploy your own instance from your own fork; a
[release](https://github.com/lswith/imap-mcp/releases) is the signal that
something worth merging has landed.

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

Six tools: `search_messages`, `get_message`, `get_thread`, `flag_message`,
`move_message`, `create_draft`. Bodies leave one at a time, capped, inside an
untrusted-content envelope; there is no send and no delete, structurally —
the codebase contains no SMTP client and no delete path. Every write is
audited. [`docs/architecture.md`](./docs/architecture.md) is the full design
essay.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lswith/imap-mcp)

**What it costs, before you click:** the sync fan-out runs on Cloudflare
Queues, which requires the **Workers Paid plan** (US$5/month at time of
writing) — a free-plan deploy fails at queue provisioning. Everything else
fits comfortably in the paid plan's included usage for one mailbox. You also
need a mailbox **app-specific password**; on iCloud it grants full mailbox
access including SMTP send, so treat it like the account password.

The button provisions the database, queues and bucket, prompts for the two
required secrets — the mailbox password and an MCP API key — and deploys.
Migrations run inside the deploy script, so the schema is applied on the first
deploy and on every redeploy after you merge an upstream change. You get a
working endpoint authenticated by the API key; putting Cloudflare Access in
front of it is an optional, documented upgrade. The button deploys `main`
until releases exist ([#38](https://github.com/lswith/imap-mcp/issues/38)).

[`docs/deploy.md`](./docs/deploy.md) is the full guide — the button path, the
manual path, and the configuration reference.
[`docs/authentication.md`](./docs/authentication.md) covers the two auth modes
and the trade between them.

## Quickstart, for working on it

No Cloudflare account needed — the whole suite runs offline:

```bash
pnpm install
pnpm run test        # vitest: workerd + a scripted-IMAP-server protocol suite
pnpm run lint        # biome (lint + format)
pnpm run typecheck   # wrangler types + tsc --noEmit
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run
```

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the rest — including the one hard
requirement: a change to provider behaviour needs a test in the
scripted-server harness.

## Documentation

| | |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | the design essay: sync internals, gap detection, the schema, the untrusted-content envelope, the IMAP client's quirks |
| [`docs/deploy.md`](./docs/deploy.md) | nothing → working instance: button, manual path, secrets, migrations |
| [`docs/authentication.md`](./docs/authentication.md) | API key vs Cloudflare Access, the upgrade ordering, lockout recovery |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | running the suite offline, the provider-test requirement, triage |
| [`SECURITY.md`](./SECURITY.md) | the reporting channel, and an honest list of what is and is not guaranteed |
| [`AGENTS.md`](./AGENTS.md) | the compact invariants file for agents and humans alike |

## Status and roadmap

Everything below "done" is implemented and green in the test suite — a suite
that runs the real protocol client against a scripted server, and the real
Worker runtime against local storage. What has **not** happened yet is a full
production run against a real mailbox on the current architecture: that is
[#39](https://github.com/lswith/imap-mcp/issues/39), and until it lands,
"done" means *done in the suite and the spikes*, not *proven in production*.

| | |
| --- | --- |
| [#3](https://github.com/lswith/imap-mcp/issues/3)–[#12](https://github.com/lswith/imap-mcp/issues/12) | mailbox interface, schema, sync + fan-out + incremental sync, attachments, MCP server, Access gate, retrieval and write tools — *done* |
| [#34](https://github.com/lswith/imap-mcp/issues/34)–[#36](https://github.com/lswith/imap-mcp/issues/36) | one Worker, two auth modes, deploy button — *done* |
| [#37](https://github.com/lswith/imap-mcp/issues/37), [#38](https://github.com/lswith/imap-mcp/issues/38) | docs restructure, releases — *this* |
| [#39](https://github.com/lswith/imap-mcp/issues/39) | rebuild the deployment, run the backfill to completion |
| [#24](https://github.com/lswith/imap-mcp/issues/24) | flag reconciliation over CONDSTORE |
| [#31](https://github.com/lswith/imap-mcp/issues/31) | `.docx` text extraction |
| [#40](https://github.com/lswith/imap-mcp/issues/40)–[#42](https://github.com/lswith/imap-mcp/issues/42) | file cf-imap defects upstream; spikes: static-bearer client support, Gmail over IMAP |

## Licence

MIT — see [LICENSE](./LICENSE). The IMAP protocol client is
[`cf-imap`](https://github.com/Exerra/cf-imap) by Exerra, also MIT; its
licence text ships in the tarball but no `license` field is set in its
`package.json`, so licence scanners misreport it —
[`docs/architecture.md`](./docs/architecture.md#the-imap-client) has the
detail and the known workarounds this repo pins with tests.
