// The real stdio server, as Claude Desktop runs it, pointed at a database that does not
// exist. A tool call must come back as an isError result, the process must stay up and
// keep answering, and the failure must be logged as structured JSON on stderr.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DB_UNAVAILABLE_MESSAGE } from "../../src/guard.js";
import { textOf, type ToolResult } from "../helpers/mcp.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Nothing listens on port 1: every connection is refused.
const DEAD_DB = "postgresql://postgres@127.0.0.1:1/jobhunt_test";

let transport: StdioClientTransport;
let client: Client;
const stderr: string[] = [];

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: DEAD_DB,
      DATABASE_URL_READER: DEAD_DB.replace("postgres@", "mcp_reader@"),
      APPROVAL_PORT: "0",
      LOG_LEVEL: "info",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(...chunk.toString().split("\n").filter(Boolean)));
  client = new Client({ name: "vitest", version: "0.0.1" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

it("answers isError instead of crashing, keeps serving, and logs JSON", { timeout: 30_000 }, async () => {
  const r = await call("list_applications");
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe(DB_UNAVAILABLE_MESSAGE);

  // Still alive: the next request is answered.
  const ping = await call("ping");
  expect(ping.isError).toBeUndefined();
  expect(transport.pid).not.toBeNull();
  expect(() => process.kill(transport.pid!, 0)).not.toThrow();

  // Every stderr line is a JSON object; the failure is there with its fields.
  const lines = stderr.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines.find((l) => l.tool === "list_applications" && l.dbUnavailable === true)).toMatchObject({
    level: "error",
    component: "tool",
    service: "jobhunt-mcp",
  });
});
