# Gating the MCP endpoint with Cloudflare Access

The MCP endpoint has no folder fence, so it is functionally read access to the
whole mailbox. Authentication is the load-bearing control in this design, not
hygiene on top of it — which is why the worker verifies the Access token itself
rather than trusting that the edge did.

This is the Access half of a deploy. The full deploy-from-scratch guide is
[#13](https://github.com/lswith/imap-mcp/issues/13); this page will fold into
it. `scripts/setup-access.sh` walks the same steps interactively and writes the
values it collects into a gitignored `.env`.

## What you need first

- A Cloudflare account with **Zero Trust** enabled and an identity provider
  configured. The free plan covers 50 users.
- A **zone on that account** to hang the hostname off.
- **Workers Paid**, for the queues the sync worker needs. Not an Access
  requirement, but the same deploy.

## How it fits together

The mechanism is Access **Managed OAuth**, and one detail of it explains the
rest of this page:

```
  MCP client                Cloudflare Access               this worker
      │                            │                             │
      │── request, no token ──────▶│                             │
      │◀─ 401 + WWW-Authenticate ──│   (not a 302 — that is       │
      │      resource_metadata=…   │    what Managed OAuth buys)  │
      │                            │                             │
      │── OAuth authorization code flow, in the user's browser ──▶│
      │◀─ opaque token "oauth:…" ──│                             │
      │                            │                             │
      │── request + opaque token ─▶│──── request ───────────────▶│
      │                            │     ctx.access = { aud, … }  │ checks:
      │                            │                              │  present?
      │                            │                              │  aud match?
```

The token the **client** holds is opaque and cannot be verified by anyone but
Access. The worker never sees it. What the worker gets is `ctx.access`, which
the Workers runtime populates for a request Access authenticated — so
`src/access.ts` reads no header at all.

That is the stronger of the two options rather than merely the newer one. A
header (`Cf-Access-Jwt-Assertion`, which Access also still forwards) is request
data: trustworthy only for as long as nothing can reach the worker without
traversing Access. `ctx.access` is set by the runtime, cannot be spoofed by a
caller, and is simply absent when Access did not run — which is a refusal.

What the worker still has to check is the **audience**. Access authenticating
someone is not the same claim as Access authenticating them for *this*
application, and one Zero Trust account can hold many.

Default Access answers a non-browser client with a `302` to a login page it
cannot complete. Managed OAuth is what turns that into a spec-compliant `401`
with a `WWW-Authenticate` header. **It is off by default and must be turned
on**, or no MCP client will connect.

Service tokens are not an alternative: claude.ai custom connectors and the
Claude API MCP connector send no custom headers at all, so `CF-Access-Client-Id`
only ever works from Claude Code.

## Setting it up

1. **Zero Trust → Access controls → Applications → Add an application →
   Self-hosted.** Give it the hostname you intend to serve the worker on, e.g.
   `mail-mcp.example.com` on a zone you hold. That hostname must match the
   `routes` entry you add in step 6.

2. **Add a policy.** Action *Allow*, one rule, `Emails` → your own address. This
   is read access to your entire mail archive; there is no reason for it to be
   broader. Make sure no *Bypass* policy exists on the same hostname.

3. **Advanced settings → turn on Managed OAuth.** This is the step everything
   else depends on. While you are there:
   - *Allow localhost clients* and *Allow loopback clients* — Claude Code needs
     these for its redirect.
   - Add `https://claude.ai/api/mcp/auth_callback` to the allowed redirect URIs,
     for the claude.ai custom connector.
   - Access token lifetime 5–15 minutes, session duration 1–2 weeks, is a
     reasonable pairing for CLI and agent clients.

4. **Overview tab → copy the Application Audience Tag.** A hex string. This is
   `ACCESS_AUD`, and it must be *this* application's tag: every application in
   one Zero Trust account is signed by the same keys, so the audience is the
   only thing that distinguishes them — and the worker pins it.

5. **Add the `var` and the `routes` entry to your own copy of
   `packages/mcp/wrangler.jsonc`.** Neither is committed; this repository is
   public.

   ```jsonc
   "vars": { "ACCESS_AUD": "<application audience tag>" },
   "routes": [{ "pattern": "mail-mcp.example.com", "custom_domain": true }]
   ```

   Leave `workers_dev` and `preview_urls` at `false`. A `workers.dev` hostname
   is not one your Access application covers.

6. **Deploy — in this order.** Neither `wrangler.jsonc` commits a
   `database_id`, so whichever worker you deploy first provisions the D1
   database *both* share, and wrangler writes the id back into that worker's
   config. Deploying this one first provisions it from the wrong side, and the
   second deploy then creates a second database. Nothing errors; the MCP server
   just serves an empty index for ever.

   ```bash
   pnpm --filter @imap-mcp/sync run deploy   # first — provisions D1. See
                                             # README.md -> First deploy
   pnpm run db:migrate:remote                # apply the schema; a no-op if re-run
   pnpm --filter @imap-mcp/mcp run deploy    # then this one
   ```

   Afterwards, check that the `database_id` wrangler wrote into
   `packages/mcp/wrangler.jsonc` matches the one in
   `packages/sync/wrangler.jsonc`. Both ids are yours — don't push them
   upstream.

## Checking it worked

```bash
# 1. Unauthenticated: 401 with a challenge, and NO Location header.
#    A 302 here means Managed OAuth is still off (step 3).
curl -sSD- -o /dev/null https://mail-mcp.example.com/mcp

# 2. Discovery resolves.
curl -sS https://mail-mcp.example.com/.well-known/oauth-authorization-server | jq
curl -sS https://mail-mcp.example.com/.well-known/oauth-protected-resource | jq

# 3. The workers.dev hostname does not exist.
curl -sS https://imap-mcp-server.<account>.workers.dev/mcp
```

**The check that actually matters.** Everything above passes identically for a
worker whose gate never runs, because an unauthenticated request is refused
either way. What proves the gate works is the *authenticated* path: complete the
Claude Code login below and confirm a search returns results. If `ctx.access`
were not reaching the worker, that request would come back `401` rather than
succeeding — a signed-in user seeing `401` means Access is authenticating at the
edge but the runtime context is not arriving, which is the one failure mode this
design has. If you hit it, check that the Access application covers the exact
hostname the route serves.

Then the clients:

- **Claude Code** —
  `claude mcp add --transport http imap-mcp https://mail-mcp.example.com/mcp`,
  then `/mcp`. A browser opens on the Access login; afterwards `search_messages`
  appears in the tool list.
- **claude.ai** — Settings → Connectors → Add custom connector, same URL. The
  Access login runs in a popup.

## When something is wrong

| Symptom | Cause |
| --- | --- |
| `302` instead of `401` | Managed OAuth is off (step 4) |
| Every request `500` | `ACCESS_AUD` is unset. The gate fails closed rather than falling open — this is working as designed |
| Every request `401`, even after a successful login | Either the AUD in `wrangler.jsonc` belongs to a different application, or `ctx.access` is not reaching the worker. Check the AUD first; see the note under "Checking it worked" for the second |
| `503` | The worker could not reach `<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Deliberately not a `401`: telling a client its good token was revoked costs the user a browser window for what is usually a blip |
| `403` | The Origin check, not Access. A browser on another site — including a DNS-rebound one carrying a real Access cookie — is refused before its identity is considered |
| `401` locally under `wrangler dev` | Expected. Access is not in front of a local worker, so `ctx.access` is undefined. Add an `access.dev` block to your own copy of `wrangler.jsonc` to simulate a signed-in user — see `packages/mcp/.dev.vars.example` |
