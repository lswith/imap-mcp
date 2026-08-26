#!/usr/bin/env node
/**
 * Generate the wrangler config a deploy actually uses, from the committed one
 * plus your `.env`.
 *
 * This repository is public, so `packages/*​/wrangler.jsonc` carries no account
 * id, no route, no audience tag and no `database_id`. Supplying them by hand
 * meant editing a committed file and remembering never to commit it — which is
 * a rule, not a mechanism, and one `git add -A` away from failing.
 *
 * Wrangler's redirected configuration turns it into a mechanism. A
 * `.wrangler/deploy/config.json` naming another file makes wrangler read *and
 * write back to* that file instead, and `.wrangler/` is already gitignored. So
 * the committed config stays pristine, and the deployment values live in `.env`
 * where they belong.
 *
 * Generated rather than hand-copied, deliberately: a copy goes stale the moment
 * the committed config gains a binding, and #9 (R2) and #12 (a service binding)
 * both will. Regenerating on every deploy means those flow through without
 * anyone remembering to sync anything.
 *
 * Scope, which is narrower than it looks: the redirect is followed by
 * `wrangler deploy`, `dev`, and `versions upload`/`deploy` — but NOT by
 * `wrangler types`. So `pnpm run typecheck` still reads the committed config,
 * and so does the test suite, which names `./wrangler.jsonc` explicitly in
 * vitest.config.ts. Nothing about this changes what CI checks.
 *
 * Usage: node scripts/deploy-config.mjs <mcp|sync>
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");

/**
 * Strip JSONC comments without disturbing anything inside a string.
 *
 * Written out rather than pulled in, because a `//` inside a string literal is
 * exactly what a naive regex eats — and this file's input contains URLs. Ten
 * lines of state machine is cheaper than a dependency on a repo that adds none.
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let comment = null; // "line" | "block" | null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (comment === "line") {
      if (ch === "\n") {
        comment = null;
        out += ch;
      }
      continue;
    }
    if (comment === "block") {
      if (ch === "*" && next === "/") {
        comment = null;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      comment = "line";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      comment = "block";
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** `KEY=value` lines. Blank lines and `#` comments ignored; quotes trimmed. */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value) env[match[1]] = value;
  }
  return env;
}

/**
 * Build the deploy config from the committed one.
 *
 * Every path in the committed file is relative to *it*, and the generated file
 * sits three directories deeper. Rather than reason about which of the two
 * wrangler resolves against, they are made absolute — correct under either
 * reading, and the generated file is machine-local so absolute paths cost
 * nothing.
 */
export function buildConfig({ base, packageDir, env, pkg, existingDatabaseId }) {
  const config = structuredClone(base);
  const absolute = (value) => (isAbsolute(value) ? value : resolve(packageDir, value));

  if (typeof config.$schema === "string") config.$schema = absolute(config.$schema);
  if (typeof config.main === "string") config.main = absolute(config.main);

  for (const binding of config.d1_databases ?? []) {
    if (typeof binding.migrations_dir === "string") {
      binding.migrations_dir = absolute(binding.migrations_dir);
    }
    // Precedence: .env wins, then whatever wrangler last wrote into the
    // generated file. Losing this id is not a small mistake — wrangler would
    // provision a SECOND database and the MCP server would serve an empty
    // index for ever, silently. See README -> First deploy.
    const id = env.D1_DATABASE_ID ?? existingDatabaseId;
    if (id) binding.database_id = id;
  }

  if (pkg === "mcp") {
    if (env.ACCESS_AUD) config.vars = { ...config.vars, ACCESS_AUD: env.ACCESS_AUD };
    if (env.MCP_ROUTE_PATTERN) {
      // biome-ignore lint/style/useNamingConvention: wrangler's own config field.
      config.routes = [{ pattern: env.MCP_ROUTE_PATTERN, custom_domain: true }];
    }
    // `wrangler dev` follows this redirect too, and Access cannot run in front
    // of a local worker — so without this every local request is a 401. This is
    // the only place that block can live without touching a committed file.
    if (env.ACCESS_AUD) {
      config.access = {
        dev: {
          aud: env.ACCESS_AUD,
          identity: { email: env.ACCESS_DEV_EMAIL ?? "dev@example.invalid" },
        },
      };
    }
  }

  // Redirected configs must carry no `environments` block. This repo declares
  // none, so this is a guard rather than a transformation.
  delete config.env;
  return config;
}

function main() {
  const pkg = process.argv[2];
  if (pkg !== "mcp" && pkg !== "sync") {
    console.error("usage: node scripts/deploy-config.mjs <mcp|sync>");
    process.exit(2);
  }

  const packageDir = join(ROOT, "packages", pkg);
  const deployDir = join(packageDir, ".wrangler", "deploy");
  const generatedPath = join(deployDir, "wrangler.json");
  const redirectPath = join(deployDir, "config.json");

  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  const supplied = ["ACCESS_AUD", "MCP_ROUTE_PATTERN", "D1_DATABASE_ID"].some((key) => env[key]);

  // Nothing to inject: remove any stale redirect and let wrangler read the
  // committed config, exactly as a fresh clone does. Deploying without a .env
  // is a legitimate thing to do — it is what `pnpm run build` does in CI.
  if (!supplied) {
    if (existsSync(redirectPath)) rmSync(redirectPath);
    console.log(
      `[deploy-config] no deployment values in .env — using packages/${pkg}/wrangler.jsonc`,
    );
    return;
  }

  // Read back whatever wrangler wrote into the last generated config before
  // overwriting it, so a provisioned database_id survives regeneration.
  let existingDatabaseId;
  if (existsSync(generatedPath)) {
    const previous = JSON.parse(readFileSync(generatedPath, "utf8"));
    existingDatabaseId = previous.d1_databases?.[0]?.database_id;
  }

  const base = JSON.parse(
    stripJsonComments(readFileSync(join(packageDir, "wrangler.jsonc"), "utf8")),
  );
  const config = buildConfig({ base, packageDir, env, pkg, existingDatabaseId });

  mkdirSync(deployDir, { recursive: true });
  writeFileSync(generatedPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(redirectPath, `${JSON.stringify({ configPath: "./wrangler.json" }, null, 2)}\n`);

  // .env is the durable record; .wrangler/ is a cache you can delete. Promote
  // the id the moment we see one, so deleting the cache is never destructive.
  if (existingDatabaseId && !env.D1_DATABASE_ID && existsSync(ENV_FILE)) {
    const line = `\n# Written back by scripts/deploy-config.mjs after wrangler provisioned D1.\n# Both workers must share this id -- see README.md -> First deploy.\nD1_DATABASE_ID=${existingDatabaseId}\n`;
    writeFileSync(ENV_FILE, readFileSync(ENV_FILE, "utf8") + line);
    console.log(`[deploy-config] recorded D1_DATABASE_ID in .env`);
  }

  const injected = [
    env.ACCESS_AUD && pkg === "mcp" ? "ACCESS_AUD" : null,
    env.MCP_ROUTE_PATTERN && pkg === "mcp" ? "route" : null,
    config.d1_databases?.[0]?.database_id ? "database_id" : null,
  ].filter(Boolean);
  console.log(
    `[deploy-config] packages/${pkg}: ${injected.join(", ") || "nothing"} -> ${generatedPath}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
