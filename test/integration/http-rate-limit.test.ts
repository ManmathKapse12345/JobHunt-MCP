// The HTTP server's per-IP rate limit, on a real Express app with a tiny limit.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http-app.js";

const TOKEN = "t".repeat(40);
let server: Server | undefined;
let closeSessions: (() => Promise<void>) | undefined;

async function start(limit: number): Promise<string> {
  const http = createHttpApp({
    mcpAuthToken: TOKEN,
    adminToken: "admin-token-for-tests",
    approvalOrigins: ["http://127.0.0.1"],
    trustProxy: false,
    rateLimitPerMinute: limit,
  });
  closeSessions = http.closeSessions;
  server = http.app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await closeSessions?.();
  await new Promise((r) => server?.close(r));
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
};
const post = (base: string, auth = true) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth && { Authorization: `Bearer ${TOKEN}` }),
    },
    body: JSON.stringify(initialize),
  });

describe("rate limit", () => {
  it("allows the limit, then answers 429 with Retry-After as a JSON-RPC error", async () => {
    const base = await start(3);
    for (let i = 0; i < 3; i++) expect((await post(base)).status).toBe(200);

    const limited = await post(base);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("ratelimit-policy")).toMatch(/q=3/);
    expect(await limited.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, message: expect.stringMatching(/Too many requests/) } });
  });

  it("counts requests with a bad token too: it runs before auth", async () => {
    const base = await start(2);
    expect((await post(base, false)).status).toBe(401);
    expect((await post(base, false)).status).toBe(401);
    expect((await post(base, false)).status).toBe(429);
    expect((await post(base, true)).status).toBe(429); // same IP: a good token doesn't skip it
  });

  it("covers the approval page, with an HTML answer", async () => {
    const base = await start(1);
    await fetch(`${base}/login`);
    const limited = await fetch(`${base}/login`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("never limits /healthz (Render polls it)", async () => {
    const base = await start(1);
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
