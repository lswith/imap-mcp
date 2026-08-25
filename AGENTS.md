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

Early. The mailbox interface (`packages/imap`, #3) is implemented and tested;
both workers are still placeholders. The rest is tracked as issues on this
repo: #4 the D1 schema, #5 the tracer sync, #7 the MCP server, #10 Access. See
the roadmap table in README.md for the full list.

Constraints already built into `packages/imap`, because the tickets downstream
of it depend on them: everything is addressed by UID, fetches always PEEK,
`ENABLE` is connection configuration so it cannot be issued after the first
`SELECT`, flag writes are verified by reading back, and `EXPUNGE` is reachable
only as `UID EXPUNGE` over an explicit set.
