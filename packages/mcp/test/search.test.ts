import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_LIMIT, searchMessages } from "../src/search";
import { clearIndex, seedMessage } from "./support/seed";

async function hits(input: Parameters<typeof searchMessages>[1]) {
  const outcome = await searchMessages(env.DB, input);
  if (!outcome.ok) throw new Error(`expected a result set, got: ${outcome.reason}`);
  return outcome;
}

describe("searchMessages", () => {
  beforeEach(clearIndex);

  it("ranks a subject match above a body match", async () => {
    await seedMessage({ subject: "Nothing to see", body: "the invoice is attached" });
    await seedMessage({ subject: "Quarterly invoice", body: "nothing to see" });

    const { hits: found } = await hits({ query: "invoice" });

    expect(found.map((hit) => hit.subject)).toEqual(["Quarterly invoice", "Nothing to see"]);
  });

  it("returns the identity a follow-up tool would need, and a snippet", async () => {
    const id = await seedMessage({
      folder: "Archive",
      uid: 9931,
      subject: "Quarterly invoice",
      body: "the shipment arrives Tuesday",
      from: "alice@example.com",
      date: "2026-03-04T09:12:00Z",
      hasAttachments: true,
    });

    const [hit] = (await hits({ query: "shipment" })).hits;

    expect(hit).toMatchObject({
      id,
      folder: "Archive",
      uid: 9931,
      uidValidity: 100,
      subject: "Quarterly invoice",
      fromAddress: "alice@example.com",
      internalDate: Date.parse("2026-03-04T09:12:00Z"),
      hasAttachments: true,
    });
    expect(hit?.snippet).toContain("shipment");
  });

  it("narrows by folder", async () => {
    await seedMessage({ folder: "Archive", subject: "invoice one" });
    await seedMessage({ folder: "Lists/rust-dev", subject: "invoice two" });

    const { hits: found } = await hits({ query: "invoice", folder: "Lists/rust-dev" });

    expect(found.map((hit) => hit.subject)).toEqual(["invoice two"]);
  });

  it("narrows by sender, on a substring and without regard to case", async () => {
    await seedMessage({ subject: "invoice one", from: "receipts@stripe.com" });
    await seedMessage({ subject: "invoice two", from: "alice@example.com" });

    const { hits: found } = await hits({ query: "invoice", from: "STRIPE" });

    expect(found.map((hit) => hit.subject)).toEqual(["invoice one"]);
  });

  it("narrows by date range", async () => {
    await seedMessage({ subject: "invoice early", date: "2026-01-05T00:00:00Z" });
    await seedMessage({ subject: "invoice late", date: "2026-06-05T00:00:00Z" });

    expect((await hits({ query: "invoice", since: "2026-03-01" })).hits).toHaveLength(1);
    expect((await hits({ query: "invoice", until: "2026-03-01" })).hits).toHaveLength(1);
    expect(
      (await hits({ query: "invoice", since: "2026-01-01", until: "2026-12-31" })).hits,
    ).toHaveLength(2);
  });

  it("counts a bare until date as the whole of that day", async () => {
    await seedMessage({ subject: "invoice noon", date: "2026-03-04T12:00:00Z" });

    expect((await hits({ query: "invoice", until: "2026-03-04" })).hits).toHaveLength(1);
  });

  it("refuses a date it cannot read rather than ignoring the filter", async () => {
    await expect(
      searchMessages(env.DB, { query: "invoice", since: "last tuesday" }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(searchMessages(env.DB, { query: "invoice", until: "??" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("refuses a query with no searchable terms", async () => {
    await expect(searchMessages(env.DB, { query: "-()" })).resolves.toMatchObject({ ok: false });
  });

  it("bounds the result set and says there is more", async () => {
    for (let n = 0; n < 4; n++) await seedMessage({ subject: `invoice ${n}` });

    const bounded = await hits({ query: "invoice", limit: 2 });

    expect(bounded.hits).toHaveLength(2);
    expect(bounded.more).toBe(true);
  });

  it("clamps a limit no caller should be able to raise", async () => {
    for (let n = 0; n < MAX_LIMIT + 1; n++) await seedMessage({ subject: `invoice ${n}` });

    const flooded = await hits({ query: "invoice", limit: 5000 });

    expect(flooded.hits).toHaveLength(MAX_LIMIT);
    expect(flooded.more).toBe(true);
  });

  it("says so when nothing is left over", async () => {
    await seedMessage({ subject: "invoice one" });

    expect((await hits({ query: "invoice", limit: 20 })).more).toBe(false);
  });

  it("hides rows left behind by a UIDVALIDITY change", async () => {
    // The folder has moved on to 200; the row under 100 is a generation whose
    // uids no longer address anything on the server.
    await seedMessage({ folderUidValidity: 200, uidValidity: 100, subject: "invoice stale" });
    await seedMessage({ folderUidValidity: 200, uidValidity: 200, subject: "invoice current" });

    const { hits: found } = await hits({ query: "invoice" });

    expect(found.map((hit) => hit.subject)).toEqual(["invoice current"]);
  });

  it("still serves a folder that has never reported a UIDVALIDITY", async () => {
    await seedMessage({ folderUidValidity: null, uidValidity: 0, subject: "invoice unknown" });

    expect((await hits({ query: "invoice" })).hits).toHaveLength(1);
  });

  it("handles a message indexed with no body at all", async () => {
    await seedMessage({ subject: "Quarterly invoice", body: null });

    const [hit] = (await hits({ query: "invoice" })).hits;

    // snippet() answers NULL over a NULL body, and a null here reaches the
    // renderer as a field it would try to flatten.
    expect(hit?.snippet).toBe("");
  });

  it("never returns the body it searched", async () => {
    await seedMessage({
      subject: "Quarterly invoice",
      body: `shipment ${"filler ".repeat(200)}pineapple-under-the-sea`,
    });

    const found = await hits({ query: "shipment" });

    expect(JSON.stringify(found)).not.toContain("pineapple-under-the-sea");
  });
});
