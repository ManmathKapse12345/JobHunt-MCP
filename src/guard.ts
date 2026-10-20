import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isDbUnavailable } from "./db/errors.js";
import { log } from "./log.js";
import { text } from "./tools/format.js";

// Error handling for everything the model can call, in one place.
//
// Without this, the SDK turns a thrown error into a tool result whose text is the raw
// error message ("connect ECONNREFUSED ...", a Postgres error naming tables and roles).
// With it:
//   - database unreachable -> a clear isError result the model can relay ("try again shortly")
//   - any other bug        -> a generic isError result with a short reference; the full
//                             error and stack go to the log under the same reference
//   - every tool call      -> one structured log line (tool, duration, outcome)
// The server process keeps running either way.

export const DB_UNAVAILABLE_MESSAGE =
  "The job tracker's database can't be reached right now, so this could not be done. " +
  "Tell the user and suggest trying again in a minute.";

// biome-ignore lint/suspicious/noExplicitAny: wraps SDK callbacks of every shape
type Callback = (...args: any[]) => unknown;

// Call before registering anything: tools, resources and prompts registered afterwards are guarded.
export function guardHandlers(server: McpServer): void {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: never, cb: Callback) =>
    registerTool(name, config, guardTool(name, cb) as never)) as typeof server.registerTool;

  const registerResource = server.registerResource.bind(server) as (...args: unknown[]) => unknown;
  server.registerResource = ((name: string, uri: unknown, config: unknown, cb: Callback) =>
    registerResource(name, uri, config, guardRequest("resource", name, cb))) as typeof server.registerResource;

  const registerPrompt = server.registerPrompt.bind(server);
  server.registerPrompt = ((name: string, config: never, cb: Callback) =>
    registerPrompt(name, config, guardRequest("prompt", name, cb) as never)) as typeof server.registerPrompt;
}

function guardTool(tool: string, cb: Callback): Callback {
  return async (...args) => {
    const started = performance.now();
    const ctx = { component: "tool", tool, sessionId: sessionOf(args) };
    try {
      const result = (await cb(...args)) as { isError?: boolean };
      log.info({ ...ctx, ms: elapsed(started), isError: result?.isError === true }, "tool call");
      return result;
    } catch (err) {
      if (err instanceof McpError) throw err; // protocol-level errors are the SDK's to send
      const { message } = report(err, { ...ctx, ms: elapsed(started) }, "tool call failed");
      return text(message, true);
    }
  };
}

// Resources and prompts have no isError result: they answer with a JSON-RPC error instead.
// Same idea: a clear message out, the details in the log.
export function guardRequest<F extends Callback>(kind: "resource" | "prompt", name: string, cb: F): F {
  return (async (...args: unknown[]) => {
    try {
      return await cb(...args);
    } catch (err) {
      if (err instanceof McpError) throw err; // e.g. "resource not found"
      const { message } = report(err, { component: kind, [kind]: name, sessionId: sessionOf(args) }, `${kind} failed`);
      throw new McpError(ErrorCode.InternalError, message);
    }
  }) as F;
}

function report(err: unknown, ctx: Record<string, unknown>, msg: string): { message: string } {
  if (isDbUnavailable(err)) {
    log.error({ ...ctx, err, dbUnavailable: true }, `${msg}: database unavailable`);
    return { message: DB_UNAVAILABLE_MESSAGE };
  }
  const ref = randomUUID().slice(0, 8);
  log.error({ ...ctx, err, ref }, msg);
  return { message: `Something went wrong on the server (error ref ${ref}). Nothing more is known; tell the user.` };
}

// The SDK passes `extra` (sessionId, requestId, ...) as the last argument.
function sessionOf(args: unknown[]): string | undefined {
  return (args.at(-1) as { sessionId?: string } | undefined)?.sessionId;
}

const elapsed = (started: number) => Math.round(performance.now() - started);

// Last resort for anything outside a request (a timer, a stray promise). Log it as JSON so
// it is not lost, then exit: after an unknown failure the process state can't be trusted,
// and Render (or Claude Desktop) starts a fresh one.
export function installCrashHandlers(): void {
  const die = (kind: string) => (err: unknown) => {
    log.fatal({ err }, kind);
    process.exit(1);
  };
  process.on("uncaughtException", die("uncaught exception"));
  process.on("unhandledRejection", die("unhandled promise rejection"));
}
