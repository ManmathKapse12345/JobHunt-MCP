// HTTP smoke test: starts dist/http.js on a free local port (like Render runs it) and checks
// bearer auth, sessions, tools/resources/prompts, elicitation over HTTP, and the approval
// page's sign-in. Run from the project root:  npm run smoke:http  (npm test runs both smokes)
//
// Same database and clean-up rules as smoke.ts: rows belong to "zz Smoke Test <run id>".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { closePools, writePool as pool } from "../src/db/pool.js";
import { call, cleanupCompany, failureCount, idOf, request, test, textOf, tokenOf } from "./helpers.js";

const RUN = randomBytes(3).toString("hex");
const COMPANY = `zz Smoke Test ${RUN}`;
// Throwaway secrets for this run only.
const MCP_TOKEN = randomBytes(24).toString("hex");
const ADMIN_TOKEN = randomBytes(16).toString("hex");

// ---------- start the HTTP server ----------

const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const BASE = `http://localhost:${port}`;

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(port),
  HOST: "127.0.0.1",
  PUBLIC_URL: BASE,
  MCP_AUTH_TOKEN: MCP_TOKEN,
  APPROVAL_ADMIN_TOKEN: ADMIN_TOKEN,
};
delete childEnv.RENDER_EXTERNAL_URL;
const child = spawn(process.execPath, ["dist/http.js"], { env: childEnv, stdio: ["ignore", "inherit", "pipe"] });
let serverLog = "";
child.stderr.on("data", (d: Buffer) => (serverLog += d.toString()));

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    try {
      if ((await request(`${BASE}/healthz`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}
await waitForHealth();

async function connect(name: string, withElicitation: boolean) {
  const client = new Client({ name, version: "0.0.1" }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

const elicit = await connect("http-elicit", true);
const plain = await connect("http-plain", false);
let nextAnswer: ElicitResult = { action: "decline" };
elicit.client.setRequestHandler(ElicitRequestSchema, async () => nextAnswer);

const linkOf = (text: string) => /(http:\/\/localhost:\d+\/approve\/\S+)/.exec(text)?.[1] ?? assert.fail(text);
const cookieOf = (setCookie: string[] | undefined) => setCookie?.[0]?.split(";")[0] ?? assert.fail("no Set-Cookie");
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};
async function statusOf(id: string) {
  return (await pool.query("select status from applications where id = $1", [id])).rows[0]?.status;
}

// ---------- tests ----------
try {
  await test("healthz is public; /mcp needs the bearer token and a known session", async () => {
    const health = await request(`${BASE}/healthz`);
    assert.deepEqual([health.status, JSON.parse(health.body)], [200, { ok: true }]);

    const none = await request(`${BASE}/mcp`, { method: "POST", json: initialize });
    assert.equal(none.status, 401);
    assert.match(String(none.headers["www-authenticate"]), /^Bearer/);
    const wrong = await request(`${BASE}/mcp`, {
      method: "POST",
      json: initialize,
      headers: { Authorization: `Bearer ${MCP_TOKEN}x` },
    });
    assert.equal(wrong.status, 401);

    const auth = { Authorization: `Bearer ${MCP_TOKEN}` };
    const unknown = await request(`${BASE}/mcp`, {
      method: "POST",
      json: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers: { ...auth, "Mcp-Session-Id": "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(unknown.status, 404);
    const noSession = await request(`${BASE}/mcp`, {
      method: "POST",
      json: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers: auth,
    });
    assert.equal(noSession.status, 400);
  });

  await test("tools, resources and the prompt work over HTTP", async () => {
    const { tools } = await plain.client.listTools();
    assert.equal(tools.length, 10);
    assert.ok(plain.transport.sessionId, "the server assigned a session id");
    const { contents } = await plain.client.readResource({ uri: "jobhunt://pipeline" });
    assert.match("text" in contents[0]! ? String(contents[0].text) : "", /^Total tracked/);
    const prompt = await plain.client.getPrompt({ name: "weekly_followups", arguments: { days: "7" } });
    assert.equal(prompt.messages.length, 2);
  });

  let appId = "";
  await test("elicitation over HTTP: the approval question arrives during the tool call", async () => {
    nextAnswer = { action: "accept", content: { approve: true } };
    const r = await call(elicit.client, "add_application", { company: COMPANY, role: "HTTP Role" });
    assert.match(textOf(r), /^The user approved\. Added "HTTP Role"/);
    appId = idOf(r);
    assert.equal(await statusOf(appId), "applied");
  });

  let link = "";
  await test("no elicitation: the link uses PUBLIC_URL and the page asks to sign in first", async () => {
    const r = await call(plain.client, "update_application_status", { id: appId, status: "oa" });
    link = linkOf(textOf(r));
    assert.ok(link.startsWith(`${BASE}/approve/`), link);

    const page = await request(link);
    assert.equal(page.status, 200);
    assert.match(page.body, /Sign in to approve/);
    assert.doesNotMatch(page.body, /zz Smoke Test/, "nothing about the change before sign-in");

    const post = await request(link.split("?")[0]!, { method: "POST", form: { token: tokenOf(link), decision: "approve" } });
    assert.equal(post.status, 401);
    assert.equal(await statusOf(appId), "applied");
  });

  let cookie = "";
  await test("sign-in: wrong password and foreign Origin refused; success sets an HttpOnly cookie", async () => {
    const next = new URL(link).pathname + new URL(link).search;
    const wrong = await request(`${BASE}/login`, { method: "POST", form: { password: "nope", next } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body, /Wrong password/);

    const csrf = await request(`${BASE}/login`, {
      method: "POST",
      form: { password: ADMIN_TOKEN, next },
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(csrf.status, 403);
    const nullOrigin = await request(`${BASE}/login`, {
      method: "POST",
      form: { password: ADMIN_TOKEN, next },
      headers: { Origin: "null" },
    });
    assert.equal(nullOrigin.status, 403, "Origin: null is foreign too");

    // "no-referrer" would make browsers send "Origin: null" on our own forms (every sign-in 403).
    const form = await request(`${BASE}/login`);
    assert.equal(form.headers["referrer-policy"], "same-origin");

    // What a real browser sends for our own form: its Origin. Must get past the CSRF check.
    const browserLike = await request(`${BASE}/login`, {
      method: "POST",
      form: { password: "still-wrong", next },
      headers: { Origin: BASE },
    });
    assert.equal(browserLike.status, 401, "our own Origin reaches the password check");

    const ok = await request(`${BASE}/login`, { method: "POST", form: { password: ADMIN_TOKEN, next } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, next, "back to the approval link");
    const setCookie = ok.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/, "plain http://localhost: no Secure flag");
    cookie = cookieOf(ok.headers["set-cookie"]);

    // No open redirect: "next" may only point back to an approval link.
    const evil = await request(`${BASE}/login`, {
      method: "POST",
      form: { password: ADMIN_TOKEN, next: "https://evil.example/" },
    });
    assert.equal(evil.headers.location, "/login");
  });

  await test("signed in: review and approve; a forged cookie is not signed in", async () => {
    const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    assert.match((await request(link, { headers: { Cookie: forged } })).body, /Sign in to approve/);

    const page = await request(link, { headers: { Cookie: cookie } });
    assert.match(page.body, /Approve this change\?/);
    assert.match(page.body, /applied -&#62; oa/);

    const done = await request(link.split("?")[0]!, {
      method: "POST",
      form: { token: tokenOf(link), decision: "approve" },
      headers: { Cookie: cookie, Origin: BASE },
    });
    assert.match(done.body, /Approved/);
    assert.equal(await statusOf(appId), "oa");

    const out = await request(`${BASE}/logout`, { method: "POST", headers: { Cookie: cookie, Origin: BASE } });
    assert.match(String(out.headers["set-cookie"]?.[0]), /Max-Age=0/);
  });

  await test("DELETE /mcp ends a session; its id is then unknown", async () => {
    const { client, transport } = await connect("http-short", false);
    const id = transport.sessionId!;
    await transport.terminateSession();
    await client.close();
    const after = await request(`${BASE}/mcp`, {
      method: "POST",
      json: { jsonrpc: "2.0", id: 3, method: "tools/list" },
      headers: { Authorization: `Bearer ${MCP_TOKEN}`, "Mcp-Session-Id": id },
    });
    assert.equal(after.status, 404);
  });

  // Last: it locks this IP out of signing in for 15 minutes (on this server process).
  await test("five wrong passwords block even the right one (429)", async () => {
    for (let i = 0; i < 5; i++) {
      await request(`${BASE}/login`, { method: "POST", form: { password: `guess-${i}` } });
    }
    const blocked = await request(`${BASE}/login`, { method: "POST", form: { password: ADMIN_TOKEN } });
    assert.equal(blocked.status, 429);
  });
} finally {
  await Promise.allSettled([elicit.client.close(), plain.client.close()]);
  child.kill();
  await cleanupCompany(pool, COMPANY);
  await closePools();
}

const failures = failureCount();
if (failures) console.log(`\nServer log:\n${serverLog}`);
console.log(failures ? `\n${failures} test(s) failed` : "\nAll HTTP tests passed");
process.exitCode = failures ? 1 : 0;
