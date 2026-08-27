# Contributing

Contributions are welcome. There is no support commitment — this project is
run against one personal mailbox and maintained as time allows — but issues
are read, pull requests are reviewed, and the bar for both is written down
here rather than discovered in review.

## You do not need a Cloudflare account

The entire test suite runs offline:

```bash
pnpm install
pnpm run test
```

Two vitest projects run: `workerd` executes everything that touches D1 inside
the real Worker runtime (miniflare provides D1, R2 and the queues locally),
and `protocol` runs the genuine IMAP client against a scripted in-memory
server under Node. No network, no mailbox, no Cloudflare credentials — a
fresh clone is testing in minutes.

The rest of the gates, all of which CI runs on every pull request:

```bash
pnpm run lint        # biome — lint and format
pnpm run typecheck   # wrangler types + tsc --noEmit
pnpm run dead-code   # knip
pnpm run build       # wrangler deploy --dry-run (validates the config)
```

## The one hard requirement: provider behaviour needs a protocol test

A change to how this project speaks IMAP — a workaround for a server quirk, a
fix to MIME decoding, different flag handling, anything that alters what goes
over or comes back off the wire — **must arrive with a test in the
scripted-server harness** (`test/imap/protocol/`, driven by
`test/imap/support/server.ts`).

The reason is what the harness is for: it runs the real protocol client
against a server the test scripts, under Node, with no account and no mailbox.
That turns "iCloud does X" from an unverifiable claim in a PR description into
a mechanical requirement the build enforces — and it is what lets a change be
reviewed by someone who cannot reach the server you observed. A protocol
defect that belongs to the client library goes upstream
([#40](https://github.com/lswith/imap-mcp/issues/40) is the model) rather
than accumulating workarounds here; the harness test is what pins the
behaviour in the meantime.

The fallback for an unmerged upstream fix is a patched fork, not a
workaround: the fix lands as a pull request on
[lswith/cf-imap](https://github.com/lswith/cf-imap) (one PR per defect, each
also reported upstream), and `package.json` pins the git ref that carries it
— the fork's `prepare` script builds the package at install time. The pin
moves back to a registry release when upstream merges, and the
harness tests, which assert the *correct* behaviour, are what make that
switch safe.

## What to know before writing code

[`AGENTS.md`](./AGENTS.md) is the compact rules file — the invariants that
must survive any change, human or agent. [`docs/architecture.md`](./docs/architecture.md)
is the design essay behind them. Reading the first is required; the second
explains why the first is shaped the way it is.

Conventions in brief: TypeScript throughout, Biome for lint and format
(`pnpm run lint:fix` fixes what it can), commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/) (the changelog is
generated from them), and nothing account-specific is ever committed — this
repository is public.

## How a change lands

Everything reaches `main` through a pull request — human, agent or release
automation alike. Nothing pushes to it directly, and the rules that say so
bind the maintainer too:

- **A pull request is required**, with zero required approvals. Zero is not an
  oversight: GitHub does not let anyone approve their own pull request, and a
  one-maintainer repository that required an approval would be one that could
  never merge. The gate here is the checks, not a second pair of eyes that
  does not exist.
- **The `ci` job must be green.** It is the required status check, and it runs
  again on `main` after the merge — see the comment at the top of
  [`ci.yml`](./.github/workflows/ci.yml) for why that second run is not
  redundant. `actionlint` is deliberately *not* required: it only runs when
  `.github/workflows/**` changes, and a required check that never reports
  blocks a pull request for ever.
- **`main` cannot be force-pushed or deleted.**

Those rules live in a repository ruleset, which is a GitHub setting rather
than a file in the repository. [`.github/rulesets/main.json`](./.github/rulesets/main.json)
is a copy of it in GitHub's own export format — reviewable in a diff, and
importable under Settings → Rules → Rulesets → New ruleset → Import. It is a
record, not the enforcement; if the two ever disagree, the setting is what is
running.

Write access is held by the maintainer alone. That is what actually stops a
contributor merging their own pull request — permissions do, not the ruleset —
so the ruleset is aimed at the accounts and agents that *do* have write, which
on a repository where an agent opens most of the pull requests is the case
worth constraining.

So the contribution path is a fork: push your branch there, open a pull
request against `main`, and CI runs on it. A pull request from a fork runs
with a read-only token and no access to this repository's secrets — `ci.yml`
triggers on `pull_request` rather than `pull_request_target`, which is what
makes that true, and it needs to stay that way.

## Issues and triage

Labels run on three axes: what a thing is (`bug`, `enhancement`, …), where it
is in triage, and who should pick it up. An issue labelled as fully specified
is one an agent or a contributor can finish without asking; anything else may
need discussion first — comment before building.

Issue reports do not need a template. Say what you saw, what you expected,
and — for sync or protocol behaviour — which provider you were talking to.

## Security problems

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md) for the
reporting channel.
