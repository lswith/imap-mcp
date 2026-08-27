# Security

## Reporting

Report vulnerabilities privately through GitHub:
**[Security → Report a vulnerability](https://github.com/lswith/imap-mcp/security/advisories/new)**
on this repository. Do not open a public issue for anything exploitable — an
instance of this project is read access to somebody's entire mailbox.

There is no bounty and no SLA; reports are read and taken seriously.

## What this project guarantees

This list is exhaustive on purpose: if a property is not on it, it is not
promised, however plausible it sounds.

- **Authentication fails closed.** Every request to the MCP endpoint needs
  the API key or a Cloudflare Access identity ([docs/authentication.md](./docs/authentication.md)).
  A deploy fails until the required secrets are set, so an unauthenticated
  instance is not a state a deploy can reach — the unconfigured case is
  guarded at deploy time, not by a runtime branch someone could break.
- **Everything returned to a model is framed as untrusted.** Message bodies,
  subjects, snippets and filenames are attacker-controlled text; they are
  delivered inside a marked envelope whose closing tag carries a per-response
  nonce, bodies leave one at a time by id with a hard cap, and no tool output
  carries mailbox text outside the frame. This is an honest boundary, not
  immunity: what is inside the frame can still contain instructions, and the
  model's handling of them is the last line.
- **The mailbox credential never reaches a log line.** Every log call in the
  sync path goes through a scrubber that removes the app-specific password in
  each form it could come back off the wire — plaintext, quoted, and SASL
  base64 — including error paths, and a test proves it.
- **An authentication failure against the mailbox is never retried
  automatically.** A revoked app-specific password re-attempted at queue speed
  — or through a tool a model can call in a loop — is how an Apple ID gets
  locked, so that failure aborts loudly instead.
- **Writes are narrow and audited.** There is no send (no SMTP client exists
  in the codebase) and no delete tool; `\Deleted` is reachable only inside a
  confirmed move. Trash and Junk are refused as destinations. Every write
  attempt — including refused ones — lands in an audit table before the
  mailbox is touched.
- **Supply-chain exposure is rate-limited at install.** pnpm enforces a
  four-day minimum release age on every dependency, in CI and locally. This is
  the control doing the work — not vulnerability scanning, which finds known
  bads, but time for a compromised release to be discovered and pulled before
  this repo adopts it. Exceptions must be pinned to an exact version in a
  committed, auditable list.

## What it deliberately does not guarantee

- **No process isolation of the credential.** The app-specific password and
  the internet-facing endpoint share one Worker isolate. This stopped being
  true when the two Workers merged ([#34](https://github.com/lswith/imap-mcp/issues/34)),
  and the reasoning is recorded there: the protocol client — the least-audited
  dependency — already shared an isolate with the password, so the split
  protected less than it appeared to, and the release-age gate above is the
  mitigation that remains.
- **No per-caller authorization.** Any authenticated caller gets the same
  access to the whole index. In API-key mode the audit log cannot tell callers
  apart.
- **No rate limiting or lockout** on repeated failed authentication.
- **No protection from a malicious model.** The tools are capped and audited,
  but a caller that is *authorized* can read anything in the index by design.
