# MCP notes

How a client (Claude Desktop, the MCP Inspector, `scripts/smoke.ts`) talks to `jobhunt-mcp`, and why the server never writes logs to stdout.

## The setup

- **Host**: the app the user sees (Claude Desktop). It runs one **client** per server.
- **Client**: starts the server as a **child process** and owns the connection.
- **Server**: this project (`dist/index.js`). It offers tools; it never starts a conversation on its own.

The transport is **stdio**. The client writes to the server's **stdin** and reads its **stdout**. Each message is one line of JSON, and the format is **JSON-RPC 2.0**:

| Kind | Has `id`? | Gets a reply? | Example |
|---|---|---|---|
| Request | yes | yes, a response with the same `id` | `initialize`, `tools/list`, `tools/call` |
| Response | yes (copied from the request) | no | `{"id":3,"result":{...}}` |
| Notification | no | no | `notifications/initialized` |

The `id` is how the client matches a reply to its question. The server may answer out of order. In the capture below, request 5 came back before 3 and 4.

## The lifecycle: initialize → tools/list → tools/call

These are real messages, captured by piping JSON lines into `node dist/index.js` (long lines are shortened).

### 1. `initialize`: the handshake

The client says which protocol version it speaks and who it is:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"notes-demo","version":"0.0.1"}}}
```

The server answers with the version it agrees to use, what it supports, and its name. These come from `new McpServer({ name, version })` in [src/index.ts](../src/index.ts):

```json
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"jobhunt-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

`capabilities.tools` tells the client "I have tools, so it's worth asking for them". Then the client sends a notification (no `id`, no reply) to say the handshake is done:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

Only after this are normal requests allowed.

### 2. `tools/list`: discovery

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

The server returns every tool registered with `server.registerTool(...)`: its `name`, `title`, `description` and `inputSchema`:

```json
{"result":{"tools":[{"name":"ping","title":"Ping","description":"Health check for the jobhunt-mcp server. Returns 'pong', echoing the optional message.","inputSchema":{"type":"object","properties":{"message":{"description":"Optional text to echo back","type":"string"}}}}, ...]},"jsonrpc":"2.0","id":2}
```

The Zod schemas in the code are converted to **JSON Schema** here, because the client and the model don't know Zod.

This is the only thing the model knows about a tool. The **description** decides *when* it calls the tool, and the **schema** decides *what arguments* it sends. That's why `add_application`'s description says things like "never invent a URL, date, or notes".

### 3. `tools/call`: running a tool

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{"message":"hi"}}}
```

The SDK finds the handler, validates `arguments` against the Zod schema, runs the handler, and wraps its return value:

```json
{"result":{"content":[{"type":"text","text":"pong: hi"}]},"jsonrpc":"2.0","id":3}
```

There are two kinds of failure:

- **Tool-level error**: the call worked, but the answer is "no". The handler returns `isError: true`, and the model sees the text and can react, for example by asking for a different date:
  ```json
  {"result":{"content":[{"type":"text","text":"2030-01-01 is in the future. Please provide past dates"}],"isError":true},"jsonrpc":"2.0","id":4}
  ```
  `add_application` does the same for duplicates.
- **Protocol error**: something is wrong with the request itself, like invalid arguments or an unknown tool. JSON-RPC error codes such as `-32602` (invalid params) show up here. In this SDK version, an unknown tool still comes back as an `isError` result that carries the code:
  ```json
  {"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true},"jsonrpc":"2.0","id":5}
  ```
  That's why `expectRejected` in [scripts/smoke.ts](../scripts/smoke.ts) accepts either form.

## Why logs must go to stderr

With stdio, **stdout is the protocol channel**. The client reads every line on stdout and parses it as a JSON-RPC message.

If the server did `console.log("server started")`, that line would land on stdout. The client would try to parse `server started` as JSON and fail. Depending on the client, it either drops the line with an error or treats the connection as broken, and the tools stop working. The bug is easy to miss, because nothing looks wrong in the code.

**stderr** is a separate stream that the client does not parse. Claude Desktop saves it to its MCP log files, and the Inspector shows it in a panel. So in this project:

- `console.error(...)` is used for every log (`"jobhunt-mcp running on stdio"`, `add_application: saved ...`).
- `console.log` is never used in `src/`. It's fine in `scripts/`, because those are clients, not servers.

In the capture above, stdout had only the five JSON responses, and stderr had only `jobhunt-mcp running on stdio`. That's how it should be.

## Try it yourself

Send the handshake and one call by hand (Git Bash, after `npm run build`):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"me","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}' \
  | node dist/index.js
```

Or use the Inspector, which shows the same messages in a UI:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
