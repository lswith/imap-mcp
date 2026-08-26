import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildConfig, parseEnv, stripJsonComments } from "./deploy-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The real committed configs, not a fixture — the point is that these parse. */
function committed(pkg) {
  const path = resolve(ROOT, "packages", pkg, "wrangler.jsonc");
  return { path, dir: dirname(path), text: readFileSync(path, "utf8") };
}

test("strips comments from both committed configs", () => {
  for (const pkg of ["mcp", "sync"]) {
    const config = JSON.parse(stripJsonComments(committed(pkg).text));
    assert.equal(config.main, "src/index.ts");
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
  }
});

test("leaves a // inside a string alone", () => {
  // The trap a regex falls into: this repo's configs are full of URLs.
  const text = '{ "a": "https://example.com/x", /* b */ "c": 1 } // end';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: "https://example.com/x", c: 1 });
});

test("does not treat an escaped quote as the end of a string", () => {
  const text = '{ "a": "he said \\" // not a comment", "b": 2 }';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: 'he said " // not a comment', b: 2 });
});

test("parses env lines, ignoring comments, blanks and quotes", () => {
  const env = parseEnv(
    ["# a comment", "", "ACCESS_AUD=abc123", 'MCP_ROUTE_PATTERN="m.example.com"', "EMPTY="].join(
      "\n",
    ),
  );
  assert.deepEqual(env, { ACCESS_AUD: "abc123", MCP_ROUTE_PATTERN: "m.example.com" });
});

test("makes every committed relative path absolute", () => {
  // The generated file sits three directories deeper than the committed one, so
  // a surviving relative path would resolve somewhere that does not exist.
  const { dir, text } = committed("mcp");
  const config = buildConfig({
    base: JSON.parse(stripJsonComments(text)),
    packageDir: dir,
    env: { ACCESS_AUD: "aud-1" },
    pkg: "mcp",
  });

  assert.equal(config.main, resolve(dir, "src/index.ts"));
  assert.equal(config.d1_databases[0].migrations_dir, resolve(ROOT, "migrations"));
  assert.ok(config.$schema.startsWith("/"));
});

test("injects the audience, the route and a dev block for the mcp worker", () => {
  const { dir, text } = committed("mcp");
  const config = buildConfig({
    base: JSON.parse(stripJsonComments(text)),
    packageDir: dir,
    env: { ACCESS_AUD: "aud-1", MCP_ROUTE_PATTERN: "m.example.com" },
    pkg: "mcp",
  });

  assert.equal(config.vars.ACCESS_AUD, "aud-1");
  // biome-ignore lint/style/useNamingConvention: wrangler's own config field.
  assert.deepEqual(config.routes, [{ pattern: "m.example.com", custom_domain: true }]);
  assert.equal(config.access.dev.aud, "aud-1");
  // Unreachability is not something a generated config may quietly undo.
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test("adds no audience or route to the sync worker", () => {
  const { dir, text } = committed("sync");
  const config = buildConfig({
    base: JSON.parse(stripJsonComments(text)),
    packageDir: dir,
    env: { ACCESS_AUD: "aud-1", MCP_ROUTE_PATTERN: "m.example.com" },
    pkg: "sync",
  });

  assert.equal(config.vars?.ACCESS_AUD, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.access, undefined);
});

test("carries a provisioned database_id forward, and lets .env override it", () => {
  // Losing this id is the failure the whole precedence rule exists to prevent:
  // wrangler would provision a second database and nothing would error.
  const { dir, text } = committed("sync");
  const base = JSON.parse(stripJsonComments(text));

  const carried = buildConfig({
    base,
    packageDir: dir,
    env: {},
    pkg: "sync",
    existingDatabaseId: "from-wrangler",
  });
  assert.equal(carried.d1_databases[0].database_id, "from-wrangler");

  const overridden = buildConfig({
    base,
    packageDir: dir,
    env: { D1_DATABASE_ID: "from-env" },
    pkg: "sync",
    existingDatabaseId: "from-wrangler",
  });
  assert.equal(overridden.d1_databases[0].database_id, "from-env");
});

test("leaves database_id absent when nothing knows it, so wrangler provisions", () => {
  const { dir, text } = committed("sync");
  const config = buildConfig({
    base: JSON.parse(stripJsonComments(text)),
    packageDir: dir,
    env: {},
    pkg: "sync",
  });

  assert.equal("database_id" in config.d1_databases[0], false);
  assert.equal(config.d1_databases[0].database_name, "imap-mcp");
});

test("never emits an environments block", () => {
  // Redirected configs must not carry one.
  const { dir, text } = committed("mcp");
  const base = JSON.parse(stripJsonComments(text));
  base.env = { production: { name: "nope" } };

  const config = buildConfig({ base, packageDir: dir, env: { ACCESS_AUD: "a" }, pkg: "mcp" });
  assert.equal("env" in config, false);
});

test("does not mutate the config it was handed", () => {
  const { dir, text } = committed("mcp");
  const base = JSON.parse(stripJsonComments(text));
  buildConfig({ base, packageDir: dir, env: { ACCESS_AUD: "a" }, pkg: "mcp" });

  assert.equal(base.main, "src/index.ts");
  assert.equal(base.vars, undefined);
});
