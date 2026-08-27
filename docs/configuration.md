# Configuration

Every value this Worker reads, what it does, and where it goes. The one rule
behind the layout: **this repository is public, so it commits the values that
identify nobody and none of the values that identify you.**

That splits configuration three ways.

| | Where it lives | Who sets it |
| --- | --- | --- |
| The mailbox and the credential | Worker **secrets** — the deploy prompts for them | you, once, at deploy time |
| The sizing knobs and `LOG_LEVEL` | the `vars` block in `wrangler.jsonc`, at their defaults | committed; change the file |
| The optional extras | `vars`, added by you after the first deploy | you, when you need them |

`GET /status` reports what is actually in effect on a running instance — worth
knowing about, because a secret cannot be read back out of the dashboard. See
[observability.md](./observability.md).

## What a deploy asks for

Four values, listed in [`.dev.vars.example`](../.dev.vars.example), which is
what the "Deploy to Cloudflare" button reads to build its prompts. Nothing else
belongs in that file: a name in it becomes a question every deployer has to
answer.

| Name | What it is |
| --- | --- |
| `IMAP_HOST` | IMAP hostname. iCloud: `imap.mail.me.com` |
| `IMAP_USER` | Mailbox user. **For iCloud, LOGIN takes the local part only** — `ada`, not `ada@icloud.com` |
| `IMAP_PASSWORD` | App-specific password. Grants *full* mailbox access including SMTP send |
| `MCP_API_KEY` | The bearer token MCP clients present. `openssl rand -base64 32` |

All four are stored as Worker secrets. Two of them are not secrets in any
meaningful sense — a hostname and a username — and are stored that way anyway,
because the secret store is the only place that is uncommitted, untouched by a
deploy, and offered by the button's prompt. `env.IMAP_HOST` reads identically
whether the value arrived as a secret or a var, so an instance already setting
them as `vars` keeps working unchanged.

Deploying by hand instead of by button:

```bash
pnpm exec wrangler secret put IMAP_HOST     # and IMAP_USER, IMAP_PASSWORD, MCP_API_KEY
```

On a *first* manual deploy the Worker does not exist yet for `secret put` to
target, so the secrets travel with the deploy — see
[deploy.md](./deploy.md#the-manual-path).

Only `IMAP_PASSWORD` and `MCP_API_KEY` are declared in `secrets.required`, so
only those two fail a deploy when missing. `IMAP_HOST` and `IMAP_USER` are
deliberately absent from that list: requiring them would break every instance
that supplies them as `vars` instead, which was the only way to do it before
the prompts existed. An unset mailbox is loud anyway — the cron fails by name,
hourly, and `/status` says `"config": {"ok": false}`.

## What is committed

The `vars` block in [`wrangler.jsonc`](../wrangler.jsonc), at exactly the
defaults `src/sync/config.ts` falls back to. Committing them changes no
behaviour; what it changes is that `wrangler deploy` prints them, the dashboard
shows them, the button offers them for editing, and `/status` reports them.

| Name | Default | What it does |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` … `silent`. Raise it in the dashboard against a running instance; put it back afterwards |
| `IMAP_PORT` | `993` | Implicit TLS |
| `SYNC_FOLDERS` | `Archive` | Comma-separated. On iCloud the mail is in Archive, not INBOX — a spike found INBOX holding single digits against Archive's tens of thousands. A folder name can contain the delimiter: `Archive,Lists/rust-dev` |
| `SYNC_CHUNK_UIDS` | `100` | Uids per queue message, and the bucket size gap detection counts in. Changing it moves every bucket boundary and re-enqueues the folder once — wasteful, not wrong |
| `SYNC_CHUNK_SIZE` | `10` | Messages per `FETCH`: the count half of the peak-memory bound |
| `SYNC_ENUMERATE_WINDOW` | `5000` | Uids per enumeration `SEARCH` |
| `SYNC_MAX_CHUNKS_PER_RUN` | `50` | Ranges one cron tick may queue — the backfill throttle, ~5,000 messages an hour |
| `SYNC_MAX_FETCH_BYTES` | `8388608` | 8 MiB. The byte half of that bound, *and* the ceiling on one message |

**Change these in the file, not the dashboard.** A deploy sets every var the
config names, so a dashboard edit to one of *these* is overwritten by the next
one. (`keep_vars` protects the names the config does *not* carry, which is the
opposite case and the one that matters.)

`SYNC_MAX_FETCH_BYTES` is worth understanding before raising it. cf-imap
materialises every attachment **twice** — decoded and base64 — on top of the
whole raw message held as a UTF-16 string, and offers no streaming API, so the
resident cost of a fetch is several times what crossed the wire; a spike
measured 2.54× for a *small* text attachment. 8 MiB against a Worker's ~128 MB
leaves room for that multiple. A message above the budget is never body-fetched
at all: it is recorded from a header-only pass with `oversize` set, because gap
detection counts rows and skipping it would leave its uid bucket permanently
short.

## What you add yourself

None of these have defaults worth committing, and all are optional. Add them as
`vars` — in your fork's `wrangler.jsonc`, or in the dashboard, where
`keep_vars` keeps them across deploys.

| Name | What it does |
| --- | --- |
| `SYNC_SINCE` | ISO date. Only mail received on or after it is indexed. Dates and uid ranges are the only `SEARCH` criteria this Worker will ever use — a spike found size and string criteria unusable against iCloud |
| `DRAFT_FROM` | The address `create_draft` writes a draft From. Defaults to `IMAP_USER` when that is a full address, which on iCloud it usually is not |
| `DRAFTS_FOLDER` | Where `create_draft` appends. Only needed when the mailbox advertises no `\Drafts` special-use *and* has no folder called Drafts |
| `ACCESS_AUD` | The Cloudflare Access upgrade. **Set it only after the Access application exists and you have verified you can authenticate through it** — see below |

### `ACCESS_AUD` is not a deploy-time question

It is deliberately absent from the prompts, and the ordering is the whole
reason: setting the audience before the Access application covers the Worker
locks you out of your own instance. Deploy first, create the application with
the Worker as its destination, verify it, *then* set the audience — during that
window the API key still carries you, so there is no gap. Deleting `ACCESS_AUD`
is the recovery. [authentication.md](./authentication.md) is the walkthrough,
and `scripts/setup-access.sh` does it interactively.

## Wrangler's own environment

Not Worker configuration at all — these configure the CLI, and go in a
gitignored `.env` or your shell:

| Name | What it does |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your account. Read by wrangler directly, which is why no `account_id` is committed |
| `CLOUDFLARE_API_TOKEN` | Only needed to deploy from CI. Not needed for `wrangler deploy --dry-run`, which is all CI runs today |

They must not go in `.dev.vars.example`: that file is the deploy prompt list,
and a Cloudflare API token is not something a Worker should ever be asked for.

## Storage

Nothing to fill in, but worth knowing before a first deploy.

- **D1** carries a `database_name` (`imap-mcp`) and deliberately no
  `database_id` — an id identifies one account. Wrangler provisions the
  database on first deploy and writes the id back into `wrangler.jsonc`. In a
  fork, commit it; deploying this repository itself, keep it as an uncommitted
  local edit. Losing it is how a *second* database gets created. Apply the
  schema with `pnpm run db:migrate:remote`.
- **Queues** — `imap-mcp-sync-chunks` and its dead-letter queue, declared by
  name and created by `wrangler deploy`. Queues runs on the free plan; what
  needs Workers Paid is the CPU limit, 10 ms free against 30 s paid, and
  parsing a message's MIME does not fit in 10 ms
  ([ADR 0001](./adr/0001-workers-paid-not-free-tier.md)).
- **R2** — `imap-mcp-attachments`, holding attachment bytes. A bucket name is
  scoped to an account rather than identifying one, so it is committed for the
  same reason the database name is.
