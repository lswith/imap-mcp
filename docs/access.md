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
      │── request + opaque token ─▶│── request + signed JWT ─────▶│
      │                            │   Cf-Access-Jwt-Assertion    │ verifies:
      │                            │                              │  signature
      │                            │                              │  iss, aud
      │                            │                              │  exp, alg
```

The token the **client** holds is opaque and cannot be verified by anyone but
Access. What reaches the **worker** is a different thing: a JWT Access signs and
forwards. So `src/access.ts` reads `Cf-Access-Jwt-Assertion`, not
`Authorization`.

Default Access answers a non-browser client with a `302` to a login page it
cannot complete. Managed OAuth is what turns that into a spec-compliant `401`
with a `WWW-Authenticate` header. **It is off by default and must be turned
on**, or no MCP client will connect.

Service tokens are not an alternative: claude.ai custom connectors and the
Claude API MCP connector send no custom headers at all, so `CF-Access-Client-Id`
only ever works from Claude Code.

## Setting it up

1. **Zero Trust → Settings → Custom Pages** (or the team-domain field in
   onboarding) — note your team domain. It looks like
   `https://<team>.cloudflareaccess.com`. Keep the scheme and drop any trailing
   slash: it is compared to the token's `iss` byte for byte.

2. **Zero Trust → Access controls → Applications → Add an application →
   Self-hosted.** Give it the hostname you intend to serve the worker on, e.g.
   `mail-mcp.example.com` on a zone you hold. That hostname must match the
   `routes` entry you add in step 6.

3. **Add a policy.** Action *Allow*, one rule, `Emails` → your own address. This
   is read access to your entire mail archive; there is no reason for it to be
   broader. Make sure no *Bypass* policy exists on the same hostname.

4. **Advanced settings → turn on Managed OAuth.** This is the step everything
   else depends on. While you are there:
   - *Allow localhost clients* and *Allow loopback clients* — Claude Code needs
     these for its redirect.
   - Add `https://claude.ai/api/mcp/auth_callback` to the allowed redirect URIs,
     for the claude.ai custom connector.
   - Access token lifetime 5–15 minutes, session duration 1–2 weeks, is a
     reasonable pairing for CLI and agent clients.

5. **Overview tab → copy the Application Audience Tag.** A hex string. This is
   `ACCESS_AUD`, and it must be *this* application's tag: every application in
   one Zero Trust account is signed by the same keys, so the audience is the
   only thing that distinguishes them — and the worker pins it.

6. **Add the two `vars` and the `routes` entry to your own copy of
   `packages/mcp/wrangler.jsonc`.** Neither is committed; this repository is
   public.

   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
     "ACCESS_AUD": "<application audience tag>"
   },
   "routes": [{ "pattern": "mail-mcp.example.com", "custom_domain": true }]
   ```

   Leave `workers_dev` and `preview_urls` at `false`. A `workers.dev` hostname
   is not one your Access application covers.

7. **Deploy:** `pnpm --filter @imap-mcp/mcp run deploy`.

## Checking it worked

The first four are the acceptance criteria; the fifth is the one that
distinguishes this from a worker that trusts the edge blindly.

```bash
# 1. Unauthenticated: 401 with a challenge, and NO Location header.
#    A 302 here means Managed OAuth is still off (step 4).
curl -sSD- -o /dev/null https://mail-mcp.example.com/mcp

# 2. Discovery resolves.
curl -sS https://mail-mcp.example.com/.well-known/oauth-authorization-server | jq
curl -sS https://mail-mcp.example.com/.well-known/oauth-protected-resource | jq

# 3. The workers.dev hostname does not exist.
curl -sS https://imap-mcp-server.<account>.workers.dev/mcp

# 4. A garbage token is refused.
curl -sSD- -o /dev/null -H 'cf-access-jwt-assertion: not-a-jwt' \
  https://mail-mcp.example.com/mcp

# 5. THE ONE THAT MATTERS. Get a valid token for a DIFFERENT Access
#    application in the same account and present it here. It is signed by the
#    same team keys and differs only in `aud`. Expect 401 — a 200 means the
#    audience pin is not working and the worker is trusting the edge.
cloudflared access login https://<some-other-app>
curl -sSD- -o /dev/null \
  -H "cf-access-jwt-assertion: $(cloudflared access token -app=https://<some-other-app>)" \
  https://mail-mcp.example.com/mcp
```

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
| Every request `500` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is unset. The gate fails closed rather than falling open — this is working as designed |
| Every request `401`, even after a successful login | The AUD belongs to a different application, or `ACCESS_TEAM_DOMAIN` carries a trailing slash |
| `503` | The worker could not reach `<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Deliberately not a `401`: telling a client its good token was revoked costs the user a browser window for what is usually a blip |
| `403` | The Origin check, not Access. A browser on another site — including a DNS-rebound one carrying a real Access cookie — is refused before its identity is considered |
| `401` locally under `wrangler dev` | Expected. Access is not in front of a local worker, so nothing attaches the header. Use `pnpm run test`, or pass a real token from `cloudflared access token` |
