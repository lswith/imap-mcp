import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_QUERY_TERMS, toMatchExpression } from "../../src/mcp/fts";

/**
 * The sanitiser's whole job is that no user string reaches MATCH as syntax, so
 * the hostile cases are checked against real FTS5 rather than against an
 * expected string: a rule that produced valid-looking output SQLite then
 * rejected would pass a string comparison and fail here.
 */
async function matches(expression: string): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?",
  )
    .bind(expression)
    .all();
  return results.length;
}

async function accepted(query: string): Promise<boolean> {
  const expression = toMatchExpression(query);
  if (expression !== null) await matches(expression);
  return true;
}

describe("toMatchExpression", () => {
  beforeAll(async () => {
    const folder = await env.DB.prepare(
      "INSERT INTO folders (name, uidvalidity) VALUES ('Archive', 100) RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO messages (folder_id, uidvalidity, uid, subject, internal_date, body_text)
       VALUES (?, 100, 1, 'Quarterly invoice', 1700000000000, 'the shipment arrives Tuesday')`,
    )
      .bind(folder?.id)
      .run();
  });

  it("quotes every term, so an implicit AND is all a caller can express", () => {
    expect(toMatchExpression("shipment tuesday")).toBe('"shipment" "tuesday"');
  });

  it("keeps a quoted phrase as one phrase", () => {
    expect(toMatchExpression('"the shipment arrives"')).toBe('"the shipment arrives"');
  });

  it("keeps a trailing star, because CJK indexes as one token", () => {
    expect(toMatchExpression("会議*")).toBe('"会議"*');
  });

  it("turns operators into literals rather than honouring them", () => {
    expect(toMatchExpression("invoice AND shipment")).toBe('"invoice" "and" "shipment"');
    expect(toMatchExpression("invoice NOT shipment")).toBe('"invoice" "not" "shipment"');
    expect(toMatchExpression("shipment NEAR/3 tuesday")).toBe('"shipment" "near/3" "tuesday"');
  });

  it("escapes an embedded quote by doubling it", () => {
    expect(toMatchExpression('say "hi')).toBe('"say" "hi"');
    expect(toMatchExpression('a"b')).toBe('"a""b"');
  });

  it("drops terms that hold nothing the tokenizer would keep", () => {
    expect(toMatchExpression("- ( ) shipment")).toBe('"shipment"');
    expect(toMatchExpression("-()")).toBeNull();
    expect(toMatchExpression("   ")).toBeNull();
    expect(toMatchExpression("")).toBeNull();
  });

  it("bounds how many terms one query may carry", () => {
    const many = Array.from({ length: MAX_QUERY_TERMS + 5 }, (_, index) => `t${index}`).join(" ");
    expect(toMatchExpression(many)?.split(" ")).toHaveLength(MAX_QUERY_TERMS);
  });

  it.each([
    "foo(",
    '"',
    '""',
    "-bar",
    "*",
    "**",
    "a OR b",
    "subject:foo",
    "^start",
    "NEAR(a b, 2)",
    "{a b} : c",
    "café",
    "会議",
    'a" OR messages_fts MATCH "b',
  ])("survives %j against real FTS5", async (query) => {
    await expect(accepted(query)).resolves.toBe(true);
  });

  it("still finds what a plain search should find", async () => {
    await expect(matches(toMatchExpression("shipment") as string)).resolves.toBe(1);
  });

  it("finds a prefix query the way the schema comment intends", async () => {
    await expect(matches(toMatchExpression("ship*") as string)).resolves.toBe(1);
  });
});
