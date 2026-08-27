# Deploying imap-mcp

From nothing to a working instance. The short version: click the button, set
two secrets, point an MCP client at the result. Everything else on this page is
the manual path and the detail behind the prompts.

> **Honesty note:** the button flow below is configuration that has been
> reviewed against Cloudflare's deploy-button documentation but not yet
> exercised end to end by a stranger's account —
> [#39](https://github.com/lswith/imap-mcp/issues/39) is the first full run.
> If something here does not match what you see, an issue report is welcome.

## What you need

- A Cloudflare account on the **Workers Paid plan** (US$5/month at time of
  writing). The sync fan-out runs on Cloudflare Queues, which the free plan
  does not include — a free-plan deploy fails at queue provisioning.
  Everything else (the Worker, D1, R2) fits comfortably in the paid plan's
  included usage for a single mailbox.
- A mailbox **app-specific password**. For iCloud: appleid.apple.com →
  Sign-In and Security → App-Specific Passwords. It grants full mailbox access
  *including SMTP send*, so treat it like the account password: it is only
  ever a Worker secret, and rotating it means revoking the old one.
- An **MCP API key** of your own choosing — the bearer token clients will
  present. Generate one: `openssl rand -base64 32`.

## The button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lswith/imap-mcp)

The button clones the repository into your account, provisions the D1
database, both queues and the R2 bucket, prompts for the two required secrets
(`IMAP_PASSWORD`, `MCP_API_KEY` — the prompts come from
[`.dev.vars.example`](../.dev.vars.example)), and deploys. Migrations run
inside the deploy script, so the schema is applied on the first deploy — and
on every later redeploy after you merge an upstream change, which is what
keeps a schema change from silently breaking your instance.

The button currently deploys the `main` branch; once releases exist
([#38](https://github.com/lswith/imap-mcp/issues/38)) it will track the latest
release instead.

When it finishes you have a Worker at
`https://imap-mcp.<your-subdomain>.workers.dev` answering `/mcp`, gated by
your API key. Two things remain before it is *useful*:

1. **Tell it about the mailbox.** Add a `vars` block to `wrangler.jsonc` in
   your fork — `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, and optionally
   `SYNC_FOLDERS` and the sizing knobs. Every value is named and explained in
   [`.env.example`](../.env.example). Push, and your fork's continuous
   deployment redeploys with them.
2. **Wait for the backfill.** The cron runs hourly and paces itself (about
   five thousand messages an hour at the defaults), so a large mailbox takes
   some hours to index. A search that returns nothing right after a deploy is
   a mailbox not yet indexed, not a broken instance.

Then connect a client:

- **Claude Code** —
  `claude mcp add --transport http --header "Authorization: Bearer <key>" imap-mcp https://<worker>.workers.dev/mcp`
- Any other MCP client that can send an `Authorization` header works the same
  way. Whether a given *hosted* client can present a static bearer token is
  [#41](https://github.com/lswith/imap-mcp/issues/41)'s question — check it
  before assuming.

## The manual path

Fork, clone, `pnpm install`. From then on:

```bash
pnpm run deploy    # d1 migrations apply, then wrangler deploy — in that order
```

The **very first** manual deploy is the one exception, because nothing exists
yet: the Worker is not there for `wrangler secret put` to target, and the
database is not there to migrate. So the first run passes the secrets
alongside the code and migrates after:

```bash
cat > .secrets.env <<DONE        # gitignored
IMAP_PASSWORD=<app-specific password>
MCP_API_KEY=<output of: openssl rand -base64 32>
DONE
pnpm exec wrangler deploy --secrets-file .secrets.env
rm .secrets.env
pnpm run db:migrate:remote
```

The deploy will fail, naming the missing names, if either secret is absent —
`secrets.required` in `wrangler.jsonc` is the guard, and it is why an
unauthenticated instance is not a state a deploy can reach. Rotate a secret
any time with `pnpm exec wrangler secret put <NAME>`.

Two write-backs land in your checkout on first deploy, and both are correct
for a fork: wrangler records the provisioned `database_id` in
`wrangler.jsonc`, and you add your mailbox `vars` there too. Commit them to
your fork; never send them upstream.

## Configuration reference

This repository is public, so **no account-specific values are committed** —
no account ID, no database id, no audience tag, no mailbox address. Everything
a deploy needs is either declared by name in `wrangler.jsonc` (resources,
required secrets) or supplied by you:

| What | Where it goes |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | your environment; wrangler reads it directly |
| `IMAP_PASSWORD`, `MCP_API_KEY` | Worker secrets — the button prompts for them; manually, `wrangler secret put` (or `--secrets-file` on the first deploy) |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER` | `vars` in your fork's `wrangler.jsonc` |
| `SYNC_FOLDERS` and the sizing vars | `vars`, all optional — [`.env.example`](../.env.example) explains each |
| `ACCESS_AUD` | only when upgrading to Cloudflare Access — see [authentication.md](./authentication.md) |
| The D1 database, queues, R2 bucket | provisioned by the first deploy; the id written back is yours |

Locally: secrets go in a gitignored `.dev.vars` (copy
[`.dev.vars.example`](../.dev.vars.example)), `pnpm run dev` runs the Worker in
API-key mode, and `pnpm run db:migrate:local` applies the schema to the local
D1.

## After the deploy

- The endpoint is gated by the API key from the first request — see
  [authentication.md](./authentication.md) for what that does and does not
  protect, and for the optional upgrade to Cloudflare Access, which ties
  authentication to your identity provider and refuses the key from then on.
- Applying migrations again is always safe: applied migrations are recorded in
  the database, so re-running is a no-op.
- There is no `wrangler d1 export` for this database (it refuses FTS5 virtual
  tables), so there is no backup taken that way. Re-running the backfill *is*
  the recovery path — the mailbox, not D1, is the source of truth.
