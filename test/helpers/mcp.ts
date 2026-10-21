import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import type { GmailDeps } from "../../src/tools/gmail.js";

export type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

// The real server and a real SDK client, joined by an in-memory pipe: the same JSON-RPC
// messages as stdio or HTTP (schema validation, elicitation...) without a process or socket.
export async function connectClient(opts: { elicitation: boolean; name?: string; gmail?: GmailDeps }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ gmail: opts.gmail });
  const client = new Client(
    { name: opts.name ?? "vitest", version: "0.0.1" },
    { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} },
  );
  await server.connect(serverSide);
  await client.connect(clientSide);

  // Plays the human answering the approval form: set `answer` before calling a write tool.
  const human = {
    answer: { action: "decline" } as ElicitResult,
    asked: [] as string[],
  };
  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      human.asked.push(String(req.params.message));
      return human.answer;
    });
  }

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  return {
    client,
    human,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

export const ACCEPT: ElicitResult = { action: "accept", content: { approve: true } };
export const DECLINE: ElicitResult = { action: "decline" };
export const CANCEL: ElicitResult = { action: "cancel" };
export const UNTICKED: ElicitResult = { action: "accept", content: { approve: false } };
