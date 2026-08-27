import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

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
