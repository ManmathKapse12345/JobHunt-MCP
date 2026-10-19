// A promptfoo custom provider: a model + the jobhunt MCP server, with the full tool loop.
//
// Why not promptfoo's built-in providers: its Gemini MCP support only passes tool
// definitions (it never runs them), and its OpenAI-style MCP support runs one round of
// tools without letting the model see the results. Safety and clarification cases need
// the model to READ tool results (an injected note, "2 applications match...") and then
// answer, so this provider runs: model -> tool calls -> tool results -> model ... -> answer.
//
// It returns the same shape as promptfoo's Anthropic MCP provider, so the cases and
// assertions don't care which model ran:
//   { output: final text, metadata: { toolCalls: [{ name, input, output, is_error }] } }
//
// config:
//   backend     "ollama" (local, default) or "gemini" (GEMINI_API_KEY)
//   model       e.g. qwen3:4b (ollama) or gemini-2.5-flash (gemini)
//   tools       false = plain chat with no MCP (used as the llm-rubric grader)
//   json        true = ask the model for JSON output (grader)
//   maxTurns    tool rounds per case (default 8, like promptfoo's max_tool_calls)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default class McpLoopProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.backend = this.config.backend ?? "ollama";
    this.model = this.config.model ?? (this.backend === "gemini" ? "gemini-2.5-flash" : "qwen3:4b");
    this.useTools = this.config.tools !== false;
    this.maxTurns = this.config.maxTurns ?? 8;
    this.mcp = undefined; // started on first use, shared by every case
  }

  id() {
    return `${this.backend}:${this.model}${this.useTools ? "+mcp" : ""}`;
  }

  // The real server through evals/server.mjs, which forces the seeded local database.
  async connect() {
    this.mcp ??= (async () => {
      const client = new Client({ name: "promptfoo-mcp-loop", version: "1.0.0" });
      // Default (minimal) environment on purpose: nothing from .env reaches the server.
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ["evals/server.mjs"] }));
      const { tools } = await client.listTools();
      return {
        client,
        tools: tools.map((t) => {
          const { $schema, ...schema } = t.inputSchema ?? { type: "object" };
          return { name: t.name, description: t.description ?? "", schema };
        }),
      };
    })();
    return this.mcp;
  }

  async callApi(prompt) {
    const { system, messages } = parsePrompt(prompt);
    const mcp = this.useTools ? await this.connect() : undefined;
    const chat =
      this.backend === "gemini"
        ? await geminiChat({ model: this.model, system, messages, tools: mcp?.tools, json: this.config.json })
        : ollamaChat({ model: this.model, system, messages, tools: mcp?.tools, json: this.config.json });

    const toolCalls = [];
    for (let turn = 0; turn <= this.maxTurns; turn++) {
      const { text, calls } = await chat.next();
      if (calls.length === 0 || !mcp) {
        return { output: text, tokenUsage: chat.usage, metadata: { toolCalls, model: this.id() } };
      }
      if (turn === this.maxTurns) {
        return { error: `still calling tools after ${this.maxTurns} rounds`, tokenUsage: chat.usage, metadata: { toolCalls } };
      }
      const results = [];
      for (const call of calls) {
        let output;
        let isError = false;
        try {
          const r = await mcp.client.callTool({ name: call.name, arguments: call.args });
          output = (r.content ?? []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
          isError = r.isError === true;
        } catch (err) {
          output = `MCP Tool Error (${call.name}): ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        toolCalls.push({ id: call.id, name: call.name, input: call.args, output, is_error: isError });
        results.push({ call, output, isError });
      }
      chat.addToolResults(results);
    }
  }
}

// promptfoo renders evals/prompt.json into a JSON chat array; the llm-rubric grader also
// sends a JSON chat array or a plain string.
function parsePrompt(prompt) {
  let msgs;
  try {
    msgs = JSON.parse(prompt);
  } catch {
    msgs = [{ role: "user", content: prompt }];
  }
  if (!Array.isArray(msgs)) msgs = [{ role: "user", content: String(prompt) }];
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  return {
    system: msgs.filter((m) => m.role === "system").map(text).join("\n\n"),
    messages: msgs.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: text(m) })),
  };
}

// ---------- Ollama (local) ----------
// Native chat API: http://localhost:11434/api/chat with function tools.

function ollamaChat({ model, system, messages, tools, json }) {
  const history = [...(system ? [{ role: "system", content: system }] : []), ...messages];
  const usage = { prompt: 0, completion: 0, total: 0, numRequests: 0 };
  return {
    usage,
    async next() {
      const res = await fetch(`${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: history,
          stream: false,
          think: false, // qwen3: answer directly (much faster on a 4 GB GPU)
          ...(json ? { format: "json" } : {}),
          ...(tools?.length
            ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })) }
            : {}),
          // Room for the tool definitions plus a few rounds; temperature 0 for repeatable runs.
          options: { num_ctx: 8192, temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      usage.prompt += data.prompt_eval_count ?? 0;
      usage.completion += data.eval_count ?? 0;
      usage.total = usage.prompt + usage.completion;
      usage.numRequests++;
      const message = data.message ?? { role: "assistant", content: "" };
      history.push(message);
      const calls = (message.tool_calls ?? []).map((c, i) => ({
        id: `call_${usage.numRequests}_${i}`,
        name: c.function?.name,
        args: typeof c.function?.arguments === "string" ? safeJson(c.function.arguments) : (c.function?.arguments ?? {}),
      }));
      return { text: message.content ?? "", calls };
    },
    addToolResults(results) {
      for (const { call, output } of results) history.push({ role: "tool", tool_name: call.name, content: output });
    },
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------- Gemini (GEMINI_API_KEY) ----------
// Note: the free tier allows only ~20 requests/day per model, far too few for 50 cases.

async function geminiChat({ model, system, messages, tools, json }) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (add it to .env)");
  const { GoogleGenAI, ApiError } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const config = {
    ...(system ? { systemInstruction: system } : {}),
    ...(json ? { responseMimeType: "application/json" } : {}),
    ...(tools?.length
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }] }
      : {}),
  };
  const usage = { prompt: 0, completion: 0, total: 0, numRequests: 0 };
  return {
    usage,
    async next() {
      const response = await geminiWithRetry(ai, ApiError, { model, contents, config });
      const u = response.usageMetadata ?? {};
      usage.prompt += u.promptTokenCount ?? 0;
      usage.completion += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      usage.total += u.totalTokenCount ?? 0;
      usage.numRequests++;
      const calls = (response.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} }));
      // Keep the model's turn exactly as returned (it carries thought signatures).
      if (calls.length) contents.push(response.candidates[0].content);
      return { text: response.text ?? "", calls };
    },
    addToolResults(results) {
      contents.push({
        role: "user",
        parts: results.map(({ call, output, isError }) => ({
          functionResponse: { id: call.id, name: call.name, response: isError ? { error: output } : { output } },
        })),
      });
    },
  };
}

// On "slow down" (429) or "overloaded" (503), wait and retry.
async function geminiWithRetry(ai, ApiError, request, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      if (![429, 500, 503].includes(status) || i >= attempts) throw err;
      // Google says how long to wait ("retryDelay": "17s"); otherwise back off.
      const hinted = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(String(err.message))?.[1];
      const waitMs = hinted ? Math.ceil(Number(hinted) * 1000) + 1000 : Math.min(60_000, 5_000 * 2 ** (i - 1));
      // A wait of hours means the DAILY quota is used up: fail now with the reason instead of sleeping.
      if (waitMs > 120_000) {
        const quota = /"quotaValue":\s*"(\d+)"/.exec(String(err.message))?.[1];
        throw new Error(
          `${request.model}: daily free-tier quota exhausted${quota ? ` (${quota} requests/day)` : ""}; ` +
            `Google says retry in ${Math.round(waitMs / 3_600_000)}h`,
        );
      }
      console.error(`gemini ${status}: waiting ${Math.round(waitMs / 1000)}s before retry ${i}/${attempts - 1}`);
      await sleep(waitMs);
    }
  }
}
