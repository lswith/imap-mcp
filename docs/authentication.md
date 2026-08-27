# Authentication

The MCP endpoint has no folder fence, so it is functionally read access to the
whole mailbox — and since the Worker is reachable at its `workers.dev`
hostname by default, authentication is the only layer between the mailbox
index and the internet. It is the load-bearing control in this design, not
hygiene on top of it.

There are two modes, and choosing between them is a decision about posture,
not a procedure:

| | API key (the floor) | Cloudflare Access (the upgrade) |
| --- | --- | --- |
| What authenticates | a shared secret, presented as a bearer token | your identity provider, via Access Managed OAuth |
| Works from the first deploy | yes — the key is a required secret, prompted for at deploy time | no — the Access application cannot exist before the Worker does |
| Who it identifies | nobody; the audit log records a null actor | the signed-in user; the audit log records their email |
| Revocation | rotate the secret (`wrangler secret put MCP_API_KEY`) | your identity provider's session controls |
| Client support | any client that can send an `Authorization` header | any client that can run an OAuth flow |

**Precedence, not fallback.** The switch is the `ACCESS_AUD` var: absent, the
API key is the credential; set, Access is required and a valid key is
*refused*. The two are never both accepted, so a key leaked before the upgrade
is not a permanent bypass of the stronger control.

The unconfigured case is guarded at deploy time rather than at runtime:
`secrets.required` in `wrangler.jsonc` makes a deploy fail, naming the missing
names, until both secrets are set — so there is no reachable state in which
the endpoint answers unauthenticated. (If a secret is deleted through the
dashboard afterwards, the comparison can never match and the gate still
refuses — closed by accident rather than by design, which is worth knowing but
not worth relying on.)

## API-key mode

Send the key as a bearer token:

```
Authorization: Bearer <MCP_API_KEY>
```

That is the only shape accepted — not a cookie, not a query parameter — and
the comparison is constant-time over SHA-256 digests. A missing or wrong key
gets a `401` with a bare `Bearer` challenge and deliberately **no** OAuth
discovery pointer: in this mode there is no authorization server to point at,
and advertising one would send a client into a flow that cannot succeed.

What this mode does and does not protect: it keeps the internet out, it works
with any client that can set a header, and it is one shared string — anyone
holding it is you, the audit log cannot tell callers apart, and rotation is
replacement (there is deliberately no list of simultaneously valid keys).
Browser-origin checks still run *before* authentication, so a malicious page
scripted to present the key is refused as a browser before the key is even
considered.

## Access mode

Access **Managed OAuth**, and one detail of it explains the rest of this page:

```
  MCP client                Cloudflare Access               imap-mcp
      │                            │                             │
      │── request, no token ──────▶│                             │
      │◀─ 401 + WWW-Authenticate ──│   (not a 302 — that is      │
      │      resource_metadata=…   │    what Managed OAuth buys) │
      │                            │                             │
      │── OAuth authorization code flow, in the user's browser ──▶
      │◀─ opaque token "oauth:…" ──│                             │
      │                            │                             │
      │── request + opaque token ─▶│──── request ───────────────▶│
      │                            │     ctx.access = { aud, … } │ checks:
      │                            │                             │  present?
      │                            │                             │  aud match?
```

The token the **client** holds is opaque and cannot be verified by anyone but
Access. The worker never sees it. What the worker gets is `ctx.access`, which
the Workers runtime populates for a request Access authenticated — so
`src/mcp/auth.ts` reads no header at all.

That is the stronger of the two options rather than merely the newer one. A
header (`Cf-Access-Jwt-Assertion`, which Access also still forwards) is request
data: trustworthy only for as long as nothing can reach the worker without
traversing Access. `ctx.access` is set by the runtime, cannot be spoofed by a
caller, and is simply absent when Access did not run — which is a refusal.

What the worker still has to check is the **audience**. Access authenticating
someone is not the same claim as Access authenticating them for *this*
application, and one Zero Trust account can hold many — another of which may
have a far more generous policy. `ACCESS_AUD` is what pins it.

### Access attaches to the Worker, not to a hostname

The application's destination is the **Worker**, not a hostname. Cloudflare
calls this "the safest and most straightforward way to put authentication in
front of a Worker", and it earns that here: it covers every route, Custom
Domain and `workers.dev` URL the Worker ever has, rather than the one URL you
name.

One constraint comes with it: worker-level Access does not support WebSockets.
MCP Streamable HTTP is POST + SSE, so this is fine today — but a future tool
that reached for WebSockets would have to move back to a hostname destination.

**This is why the deploy comes before the Access application** — you cannot
attach a Worker that does not exist — and why there is no gap in the upgrade:
until the audience is set, the API key carries you.

Service tokens are not an alternative: claude.ai custom connectors and the
Claude API MCP connector send no custom headers at all, so
`CF-Access-Client-Id` only ever works from Claude Code.

### Upgrading, in order

The ordering below is load-bearing. Set the audience *last*, after the
application demonstrably works — during that window the Access context is
present but unchecked, so the key still authenticates you and there is no gap.

`scripts/setup-access.sh` walks these steps interactively.

1. **Deploy the Worker** ([deploy.md](./deploy.md)) and confirm the API key
   works.

2. **Zero Trust → Access controls → Applications → Add an application →
   Self-hosted**, filling it in in this order:
   1. **Destinations → Add Workers → `imap-mcp`.** Not a public hostname —
      see above.
   2. Leave the **application name** alone; it defaults once the destination
      is set.
   3. **Access policies → Create new policy** → Allow, one rule, `Emails` →
      your own address. This is read access to your entire mail archive; there
      is no reason for it to be broader. No *Bypass* policy on this
      application.
   4. **Authentication** → turn **off** *Accept all available identity
      providers*, then select your identity provider explicitly.

3. **Additional settings → turn on Managed OAuth.** This is the step
   everything else depends on: default Access answers a non-browser client
   with a `302` to a login page it cannot complete, which is simply a broken
   connection for every MCP client. While you are there:
   - *Allow localhost clients* and *Allow loopback clients* — Claude Code
     needs these for its redirect.
   - Add `https://claude.ai/api/mcp/auth_callback` to the allowed redirect
     URIs, for the claude.ai custom connector.
   - Access token lifetime 5–15 minutes, session duration 1–2 weeks, is a
     reasonable pairing for CLI and agent clients.

4. **Additional settings → copy the Application Audience Tag.** A hex string,
   on the same tab. It must be *this* application's tag: every application in
   one Zero Trust account is signed by the same keys, so the audience is the
   only thing that distinguishes them — and the worker pins it.

5. **Set `ACCESS_AUD`** — a `vars` entry in your fork's `wrangler.jsonc` —
   and redeploy. From this deploy on, Access is required and the API key is
   refused.

### Recovering from a lockout

If you set the audience before the application worked, every request now gets
`401` and no login can fix it. **Delete the `ACCESS_AUD` var and redeploy** —
the instance falls straight back to API-key authentication. That is the whole
recovery, and it is why the audience is a var rather than something baked in.

### Checking it worked

```bash
# 1. Unauthenticated: 401 with a challenge, and NO Location header.
#    A 302 here means Managed OAuth is still off (step 3).
curl -sSD- -o /dev/null -X POST https://<your-worker-url>/mcp

# 2. A path the worker itself would 404 — expect 401, not 404.
#    This is the cheapest proof that Access is attached to the WORKER rather
#    than to one hostname: it gates every path, including ones the worker does
#    not serve. A 404 here means you have a hostname destination.
curl -sS -o /dev/null -w '%{http_code}\n' https://<your-worker-url>/

# 3. Discovery resolves. Access serves these itself — its own document is what
#    its 401 points at, and it shadows the worker's RFC 9728 copy, which is
#    why that copy is a backstop for `wrangler dev` rather than something
#    production depends on.
curl -sS https://<your-worker-url>/.well-known/oauth-authorization-server | jq
curl -sS https://<your-worker-url>/.well-known/oauth-protected-resource | jq
```

**The check that actually matters.** Everything above passes identically for a
worker whose gate never runs, because an unauthenticated request is refused
either way — and every one of those responses comes from Access at the edge,
not from the worker. What proves the worker works is the *authenticated* path:
complete a client login and run a search.

| What happens | Meaning |
| --- | --- |
| Tools appear and a search returns a framed result | It works — `ctx.access` reaches the worker |
| A signed-in request gets `401` | `ctx.access` is not arriving. Access authenticates at the edge but the runtime context does not reach the worker — the one failure mode no test can cover. Also check the audience is *this* application's |
| A search returns no results | Not a failure. The mailbox is not backfilled yet — getting *past the gate* is the signal |

Clients:

- **Claude Code** —
  `claude mcp add --transport http imap-mcp https://<your-worker-url>/mcp`,
  then `/mcp`. A browser opens on the Access login; afterwards
  `search_messages` appears in the tool list.
- **claude.ai** — Settings → Connectors → Add custom connector, same URL. The
  Access login runs in a popup.

### When something is wrong

| Symptom | Cause |
| --- | --- |
| `302` instead of `401` | Managed OAuth is off (step 3) |
| Every request `401`, even after a successful login | Either the audience belongs to a different application, or `ctx.access` is not reaching the worker. Check the audience first. Locked out? Delete `ACCESS_AUD` and redeploy |
| `403` | The Origin check, not authentication. A browser on another site — including a DNS-rebound one carrying a real Access cookie or scripted to present the API key — is refused before its credential is considered |
| `401` locally under `wrangler dev` | Access is not in front of a local worker. Leave `ACCESS_AUD` unset locally and dev runs in API-key mode with the key from `.dev.vars` |
