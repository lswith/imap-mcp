import { describe, expect, it } from "vitest";
// Read as text rather than parsed: what is asserted below is the file
// Cloudflare reads, byte for byte, not a re-encoding of it.
import devVarsExample from "../../.dev.vars.example?raw";
import pkg from "../../package.json";
import wranglerJsonc from "../../wrangler.jsonc?raw";

/**
 * The committed `vars` block, read from the file the deploy actually uses.
 *
 * `env` cannot answer this: the test harness injects its own bindings, so a
 * name being present there says nothing about whether the config carries it.
 * The comments are stripped a line at a time, which is how this file writes
 * them; a trailing comment would make JSON.parse throw, and a test that fails
 * loudly is the right failure for "the format assumed here changed".
 */
const committedVars: Record<string, string> = JSON.parse(
  wranglerJsonc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
).vars;

/**
 * The deploy sequence is a script rather than a document (#36), and Cloudflare
 * reads it: the deploy button and every Workers Builds redeploy of a fork run
 * the `deploy` script from this manifest. Two properties of it are load-bearing
 * and regress silently, which is why they are asserted here rather than
 * remembered.
 */
describe("the package manifest's deploy sequence", () => {
  it("applies migrations by the binding name, never the database name", () => {
    // Cloudflare's deploy-button guidance is explicit: the migration command
    // must reference the BINDING, because a user can rename the database on
    // the button's setup page. A command naming the database appears to work
    // for everyone who kept the default name — and fails at first query for
    // anyone who did not, which is exactly the defect this replaces.
    expect(pkg.scripts["db:migrate:local"]).toContain("d1 migrations apply DB ");
    expect(pkg.scripts["db:migrate:remote"]).toContain("d1 migrations apply DB ");
    expect(pkg.scripts["db:migrate:local"]).not.toContain("imap-mcp");
    expect(pkg.scripts["db:migrate:remote"]).not.toContain("imap-mcp");
  });

  it("runs migrations inside the deploy script, before the deploy", () => {
    // Continuous deployment redeploys a fork on every push, and deploying does
    // not apply migrations by itself — so the first release that changed the
    // schema would ship a Worker running against an old one. Migrations
    // preceding `wrangler deploy` in the ONE script Cloudflare pre-populates
    // covers the button, the fork's redeploys, and a deploy from a machine, in
    // an order that cannot be gotten wrong.
    expect(pkg.scripts.deploy).toMatch(/db:migrate:remote.*&&.*wrangler deploy/);
  });
});

/**
 * `.dev.vars.example` is not documentation: it is the list of questions the
 * "Deploy to Cloudflare" button asks. Cloudflare reads it (or `.env.example`,
 * which is why this repository no longer has one) and turns every name in it
 * into a prompt, so a name added here is a question put to every deployer, and
 * a name removed is a value nobody is asked for.
 *
 * Two ways that regresses silently, both of which have already happened once:
 * a variable with a committed default lands here and is asked for twice, as a
 * secret shadowing its own var; or ACCESS_AUD lands here and a deployer sets
 * the audience during the deploy that was supposed to create the application
 * it names — the documented lockout.
 */
describe("the deploy prompt list", () => {
  const prompted = Object.keys(
    Object.fromEntries(
      devVarsExample
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => [line.split("=", 1)[0], true]),
    ),
  );

  it("asks for the four values a deployer alone can supply, and nothing else", () => {
    expect(prompted).toEqual(["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "MCP_API_KEY"]);
  });

  it("never asks for a value that has a committed default", () => {
    // A secret and a var of the same name are two answers to one question,
    // and nothing decides between them. Compared against the config itself so
    // that adding a knob to the `vars` block cannot quietly create one.
    for (const name of prompted) {
      expect(committedVars).not.toHaveProperty(name);
    }
    // The comparison is only worth anything if the block was really read.
    expect(Object.keys(committedVars).length).toBeGreaterThan(0);
  });

  it("never asks for the Access audience", () => {
    // Setting ACCESS_AUD before the Access application exists locks the
    // instance out of itself. It is the upgrade after a deploy, never a
    // question during one — see docs/authentication.md.
    expect(prompted).not.toContain("ACCESS_AUD");
  });

  it("never asks for wrangler's own credentials", () => {
    // These configure the CLI, not the Worker. A template that asks for an
    // account-wide API token as if it were a Worker secret is asking for
    // something it has no business holding.
    expect(prompted.filter((name) => name.startsWith("CLOUDFLARE_"))).toEqual([]);
  });

  it("explains each prompt in the manifest Cloudflare reads", () => {
    // The dashboard shows these beside each field. Without them a stranger is
    // asked for "IMAP_USER" with no hint that iCloud wants the local part.
    expect(Object.keys(pkg.cloudflare.bindings)).toEqual(prompted);
    for (const description of Object.values(pkg.cloudflare.bindings)) {
      expect(description.length).toBeGreaterThan(20);
    }
  });
});
