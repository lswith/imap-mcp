<!--
Thanks for contributing. Two things make review about the change rather than
about process:
-->

## What this changes


## Checklist

- [ ] **If this changes provider behaviour** — anything that alters what goes
      over or comes back off the IMAP wire — it includes a test in the
      scripted-server harness (`test/imap/protocol/`). This is the one hard
      contribution requirement; see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).
- [ ] The title (and commits) follow
      [Conventional Commits](https://www.conventionalcommits.org/) — the
      changelog is generated from them, so describing your change once here is
      what puts it in the release notes.
- [ ] If this affects a deployment — a schema change, a new required secret, a
      configuration change — the commit body says so plainly. Forks learn about
      changes only through release notes.
- [ ] `pnpm run lint && pnpm run typecheck && pnpm run test` pass locally
      (no Cloudflare account needed).
