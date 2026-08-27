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

1. **Tell it about the mailbox.** `IMAP_HOST` and `IMAP_USER` are the two
   values this repository cannot commit for you — they identify your account.
   Add them to the `vars` block in your fork's `wrangler.jsonc` (the sizing
   knobs and `LOG_LEVEL` are already there, at their defaults) or in the
   dashboard, where `keep_vars` keeps them across redeploys — the second is
   the only option if you are deploying this repository rather than a fork of
   it, since its files are public. Every value is
   named and explained in [`.env.example`](../.env.example). Push, and your
   fork's continuous deployment redeploys with them.
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
`wrangler.jsonc`, and you add your mailbox host and user to the `vars` block
there too. Commit both to your fork; never send them upstream.

## Deploying this repository itself

The paragraph above assumes a fork, and one deployer it does not describe is
the one running `pnpm run deploy` **from this repository** — its maintainer,
or anyone who cloned it rather than forking it. For them the advice inverts:
there is no private fork to hold private values, and every file here is
public, so the mailbox settings must live somewhere a commit cannot reach.

Two places do, and neither is touched by a deploy:

1. **Dashboard variables** — Workers & Pages → your Worker → Settings →
   Variables. `keep_vars` in `wrangler.jsonc` is what makes this safe: a
   deploy leaves every variable the config does not name alone. Without it,
   `wrangler deploy` deletes them, and the Worker keeps answering `/mcp`
   while the cron quietly stops finding a mailbox.
2. **Worker secrets** — `pnpm exec wrangler secret put IMAP_HOST`. A host and
   a username are not secrets in the security sense, but the secret store has
   exactly the properties wanted here: never committed, never deleted by a
   deploy, and read as `env.IMAP_HOST` like any variable. The cost is that a
   secret cannot be read back, so the dashboard stops being able to tell you
   what is configured.

Either way, `GET /status` is what tells you which values are actually in
effect afterwards — see [observability.md](./observability.md).

The `database_id` write-back needs the same care: it identifies your account,
so on this repository it stays an **uncommitted local modification** to
`wrangler.jsonc` rather than something to commit. Keep that checkout, because
losing the id is how a second database gets created on the next deploy.

## Configuration reference

This repository is public, so **no account-specific values are committed** —
no account ID, no database id, no audience tag, no mailbox address. Everything
a deploy needs is either declared by name in `wrangler.jsonc` (resources,
required secrets) or supplied by you:

| What | Where it goes |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | your environment; wrangler reads it directly |
| `IMAP_PASSWORD`, `MCP_API_KEY` | Worker secrets — the button prompts for them; manually, `wrangler secret put` (or `--secrets-file` on the first deploy) |
| `IMAP_HOST`, `IMAP_USER` | `vars` in a fork's `wrangler.jsonc`; deploying this repository itself, the dashboard or `wrangler secret put` — see [above](#deploying-this-repository-itself) |
| `LOG_LEVEL`, `IMAP_PORT`, `SYNC_FOLDERS`, the sizing vars | already in the committed `vars` block at their defaults — change them there, not in the dashboard, which a deploy overwrites |
| `ACCESS_AUD` | only when upgrading to Cloudflare Access — see [authentication.md](./authentication.md) |
| The D1 database, queues, R2 bucket | provisioned by the first deploy; the id written back is yours |

Locally: secrets go in a gitignored `.dev.vars` (copy
[`.dev.vars.example`](../.dev.vars.example)), `pnpm run dev` runs the Worker in
API-key mode, and `pnpm run db:migrate:local` applies the schema to the local
D1.

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
