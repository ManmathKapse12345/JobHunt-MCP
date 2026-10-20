// The local page Google redirects back to after consent.
import { describe, expect, it } from "vitest";
import { startLoopbackReceiver } from "../../src/google/loopback.js";

const visit = (redirectUri: string, params: Record<string, string>) =>
  fetch(`${redirectUri}?${new URLSearchParams(params)}`).then(async (r) => ({ status: r.status, body: await r.text() }));

describe("loopback receiver", () => {
  it("listens on 127.0.0.1 only, on a random port", async () => {
    const r = await startLoopbackReceiver("s1");
    expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    r.close();
  });

  it("hands over the code when the state matches", async () => {
    const r = await startLoopbackReceiver("right-state");
    expect((await visit(r.redirectUri, { state: "right-state", code: "4/abc" })).status).toBe(200);
    await expect(r.code).resolves.toBe("4/abc");
  });

  it("refuses a redirect with the wrong state, and keeps waiting for the real one", async () => {
    const r = await startLoopbackReceiver("right-state");
    expect((await visit(r.redirectUri, { state: "forged", code: "4/evil" })).status).toBe(400);
    await visit(r.redirectUri, { state: "right-state", code: "4/real" });
    await expect(r.code).resolves.toBe("4/real");
  });

  it("reports a cancel on Google's page", async () => {
    const r = await startLoopbackReceiver("st");
    await visit(r.redirectUri, { state: "st", error: "access_denied" });
    await expect(r.code).rejects.toThrow(/cancelled/);
  });

  it("gives up after the timeout", async () => {
    const r = await startLoopbackReceiver("st", 50);
    await expect(r.code).rejects.toThrow(/Timed out/);
  });
});
