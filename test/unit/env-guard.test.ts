import { describe, expect, it } from "vitest";
import { assertLocalDatabase, TEST_ENV } from "../env.js";

describe("test database guard", () => {
  it("allows the docker-compose database", () => {
    expect(() => assertLocalDatabase(TEST_ENV)).not.toThrow();
  });

  it.each([
    ["DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres"],
    ["DATABASE_URL_READER", "postgresql://mcp_reader.abc:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres"],
  ])("refuses a remote %s (tests empty every table)", (key, url) => {
    expect(() => assertLocalDatabase({ ...TEST_ENV, [key]: url })).toThrow(/must point at a local database/);
  });

  it("refuses a missing URL", () => {
    expect(() => assertLocalDatabase({ DATABASE_URL: TEST_ENV.DATABASE_URL })).toThrow(/DATABASE_URL_READER/);
  });

  it("never prints the password", () => {
    expect(() => assertLocalDatabase({ ...TEST_ENV, DATABASE_URL: "postgresql://u:secret@db.example.com/x" })).toThrow(
      /^(?!.*secret).*db\.example\.com/,
    );
  });
});
