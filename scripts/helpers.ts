// Shared by smoke.ts (stdio) and smoke-http.ts (Streamable HTTP).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import assert from "node:assert/strict";
import http from "node:http";
import type pg from "pg";

export type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
export const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
export const idOf = (r: ToolResult) => /id ([0-9a-f-]{36})/.exec(textOf(r))?.[1] ?? assert.fail(textOf(r));
export const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

// Raw HTTP, so tests can send headers (Host, Origin, Cookie) the way a browser or a hostile
// page would, and read the ones that come back (Set-Cookie, Location).
export function request(
  link: string,
  opts: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(link);
  const body = opts.form
    ? new URLSearchParams(opts.form).toString()
    : opts.json !== undefined
      ? JSON.stringify(opts.json)
      : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        headers: {
          ...(opts.form && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...(opts.json !== undefined && { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
          ...opts.headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let failures = 0;
export async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}
export const failureCount = () => failures;

// Remove everything a run created (test rows only: matched by the run's company name).
export async function cleanupCompany(pool: pg.Pool, company: string) {
  await pool.query("delete from pending_actions where summary like $1", [`%${company}%`]);
  await pool.query("delete from applications where company_id in (select id from companies where name = $1)", [
    company,
  ]);
  await pool.query("delete from companies where name = $1", [company]);
}
