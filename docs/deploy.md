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
  writing). The binding constraint is CPU, not Queues: the free plan caps a
  Worker at 10 ms of CPU per invocation, and MIME parsing, base64 decoding and
  HTML-to-text extraction do not fit in that. Paid gives 30 seconds per
  invocation, raisable to five minutes with `limits.cpu_ms`. Queues itself has
  been available on the free plan since February 2026;
  [ADR 0001](./adr/0001-workers-paid-not-free-tier.md) has the full argument,
  including what a free-tier design would have cost.
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
database, both queues and the R2 bucket, **prompts for the four values only
you can supply** — `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `MCP_API_KEY`,
read from [`.dev.vars.example`](../.dev.vars.example) — and deploys.
Migrations run inside the deploy script, so the schema is applied on the first
deploy, and on every later redeploy after you merge an upstream change, which
is what keeps a schema change from silently breaking your instance.

The committed `vars` (the sizing knobs and `LOG_LEVEL`) are offered for editing
in the same flow, at their defaults. `ACCESS_AUD` is deliberately not asked
for: setting it before the Access application exists locks you out of your own
instance, so it is an upgrade you make afterwards, not a question during a
deploy. [configuration.md](./configuration.md) lists every value and where it
lives.

The button currently deploys the `main` branch; once releases exist
([#38](https://github.com/lswith/imap-mcp/issues/38)) it will track the latest
release instead.

When it finishes you have a Worker at
`https://imap-mcp.<your-subdomain>.workers.dev` answering `/mcp`, gated by
your API key, and pointed at your mailbox. One thing remains:

**Wait for the backfill.** The cron runs hourly and paces itself (about five
thousand messages an hour at the defaults), so a large mailbox takes some hours
to index. A search that returns nothing right after a deploy is a mailbox not
yet indexed, not a broken instance — and
`curl -H "Authorization: Bearer <key>" https://<worker>.workers.dev/status`
tells you which of the two you are looking at.

Then connect a client:

- **Claude Code** —
  `claude mcp add --transport http --header "Authorization: Bearer <key>" imap-mcp https://<worker>.workers.dev/mcp`
- Any other MCP client that can send an `Authorization` header works the same
  way. Whether a given *hosted* client can present a static bearer token is
  [#41](https://github.com/lswith/imap-mcp/issues/41)'s question — check it
  before assuming.

## The manual path

Fork or clone, `pnpm install`. From then on:

```bash
pnpm run deploy    # d1 migrations apply, then wrangler deploy — in that order
```

The **very first** manual deploy is the one exception, because nothing exists
yet: the Worker is not there for `wrangler secret put` to target, and the
database is not there to migrate. So the first run passes the secrets
alongside the code and migrates after:

```bash
cat > .secrets.env <<DONE        # gitignored
IMAP_HOST=<e.g. imap.mail.me.com>
IMAP_USER=<for iCloud, the local part only>
IMAP_PASSWORD=<app-specific password>
MCP_API_KEY=<output of: openssl rand -base64 32>
DONE
pnpm exec wrangler deploy --secrets-file .secrets.env
rm .secrets.env
pnpm run db:migrate:remote
```

That is the whole configuration: the same four values the button prompts for,
set as secrets. Everything else has a committed default. Change one later with
`pnpm exec wrangler secret put <NAME>` — and note that a deploy never deletes
a secret, so this survives every redeploy afterwards.

The deploy will fail, naming them, if `IMAP_PASSWORD` or `MCP_API_KEY` is
absent — `secrets.required` in `wrangler.jsonc` is the guard, and it is why an
unauthenticated instance is not a state a deploy can reach. `IMAP_HOST` and
`IMAP_USER` are deliberately not on that list, so that an instance configuring
them as `vars` instead still deploys; an unset mailbox is loud anyway, hourly
in the logs and in `/status`.

One write-back lands in your checkout on first deploy: wrangler records the
provisioned `database_id` in `wrangler.jsonc`. It identifies your account, so
in a fork it is a commit, and **on this repository it stays an uncommitted
local edit**. Keep that checkout either way — losing the id is how a second
database gets created on the next deploy.

## Configuration reference

[configuration.md](./configuration.md) is the full list: every value, what it
does, and which of the three places it belongs in. The short version —

- **The four the deploy asks for** (`IMAP_HOST`, `IMAP_USER`,
  `IMAP_PASSWORD`, `MCP_API_KEY`) are Worker secrets, listed in
  [`.dev.vars.example`](../.dev.vars.example), which is what the button reads
  to build its prompts.
- **The knobs** (`LOG_LEVEL`, `IMAP_PORT`, `SYNC_FOLDERS`, the sizing vars)
  are committed in the `vars` block at their defaults. Change them in the
  file: a deploy overwrites a dashboard edit to any name the config carries.
- **The optional extras** (`SYNC_SINCE`, `DRAFT_FROM`, `DRAFTS_FOLDER`,
  `ACCESS_AUD`) are `vars` you add afterwards, in a fork's config or in the
  dashboard, where `keep_vars` keeps them across deploys.

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` configure wrangler rather
than the Worker; they go in a gitignored `.env` or your shell.

Locally: copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`
(gitignored) and fill it in, `pnpm run dev` runs the Worker in API-key mode,
and `pnpm run db:migrate:local` applies the schema to the local D1.

## Is it working?

```bash
curl -s -H "Authorization: Bearer $MCP_API_KEY" https://<worker>.workers.dev/status | jq
```

`/status` is served behind the same gate as `/mcp` and answers, in one
document: which credential the instance accepts, whether the mailbox
configuration reads, whether migrations ran, how many messages are indexed per
folder, and whether the backfill is converging. `200` when everything it can
check itself passed, `503` when not.

Right after a first deploy, `"index": { "messages": 0 }` with `"config": {"ok":
true}` is the expected answer: the cron has not run yet. An hour later it
should be thousands. [`observability.md`](./observability.md) is the full
guide — the log lines, `LOG_LEVEL`, the queues, and what to do when a folder
stops converging.

## After the deploy

- `/status` says what the instance thinks of itself, and
  [`observability.md`](./observability.md) says how to read it.
- The endpoint is gated by the API key from the first request — see
  [authentication.md](./authentication.md) for what that does and does not
  protect, and for the optional upgrade to Cloudflare Access, which ties
  authentication to your identity provider and refuses the key from then on.
- Applying migrations again is always safe: applied migrations are recorded in
  the database, so re-running is a no-op.
- There is no `wrangler d1 export` for this database (it refuses FTS5 virtual
  tables), so there is no backup taken that way. Re-running the backfill *is*
  the recovery path — the mailbox, not D1, is the source of truth.
