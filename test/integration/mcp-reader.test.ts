// The SELECT-only mcp_reader role (supabase/migrations/003_mcp_reader.sql), against a
// database whose contents we know.
import { beforeEach, describe, expect, it } from "vitest";
import { readerConfigured, readPool, writePool } from "../../src/db/pool.js";
import { resetDb, seedApplication } from "../helpers/db.js";

let live: string;
let deleted: string;

beforeEach(async () => {
  await resetDb();
  live = await seedApplication({ company: "Stripe", role: "SDE" });
  deleted = await seedApplication({ company: "Zomato", role: "Backend", deleted: true });
});

describe("read tools' connection", () => {
  it("is the mcp_reader role, in read-only transactions", async () => {
    expect(readerConfigured).toBe(true);
    const { rows } = await readPool.query("select current_user as u, current_setting('transaction_read_only') as ro");
    expect(rows[0]).toEqual({ u: "mcp_reader", ro: "on" });
  });
});

describe("row level security", () => {
  it("lets mcp_reader see live applications and their companies and events", async () => {
    const ids = (await readPool.query("select id from applications")).rows.map((r) => r.id);
    expect(ids).toEqual([live]);
    expect((await readPool.query("select name from companies order by name")).rows.map((r) => r.name)).toEqual(["Stripe", "Zomato"]);
    expect((await readPool.query("select 1 from events where application_id = $1", [live])).rowCount).toBe(1);
  });

  it("hides soft-deleted applications even from a query that forgets the filter", async () => {
    expect((await readPool.query("select 1 from applications where id = $1", [deleted])).rowCount).toBe(0);
    expect((await writePool.query("select 1 from applications where id = $1", [deleted])).rowCount).toBe(1);
  });
});

describe("what mcp_reader cannot do", () => {
  it("write anything: transactions are read-only by default (25006)", async () => {
    await expect(readPool.query("insert into companies (name) values ('nope')")).rejects.toMatchObject({ code: "25006" });
  });

  it("write anything even in a read-write transaction: no grant (42501)", async () => {
    const c = await readPool.connect();
    try {
      for (const sql of [
        "insert into companies (name) values ('nope')",
        "update applications set notes = 'x'",
        "delete from events",
      ]) {
        await c.query("begin read write");
        await expect(c.query(sql)).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback");
      }
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
  });

  it.each(["pending_actions", "contacts"])("read %s (42501)", async (table) => {
    await expect(readPool.query(`select * from ${table} limit 1`)).rejects.toMatchObject({ code: "42501" });
  });
});
