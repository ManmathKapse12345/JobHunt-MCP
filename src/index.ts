import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 1. Create the server. name/version are sent to the client during `initialize`.
const server = new McpServer({
  name: "jobhunt-mcp",
  version: "0.1.0",
});

// 2. Register a tool. The LLM reads the description to decide WHEN to call it,
//    and the inputSchema to decide WHAT arguments to send.
server.registerTool(
  "ping",
  {
    title: "Ping",
    description:
      "Health check for the jobhunt-mcp server. Returns 'pong', echoing the optional message.",
    inputSchema: {
      message: z.string().optional().describe("Optional text to echo back"),
    },
  },
  // 3. The handler. Arguments are already validated by Zod, and `message` is
  //    typed as string | undefined thanks to inference (Day 1: Everyday Types).
  async ({ message }) => {
    return {
      content: [{ type: "text", text: message ? `pong: ${message}` : "pong" }],
    };
  },
);

server.registerTool(
  "days_since",
  {
    title: "Days Since Date",
    description:
      "Returns the number of whole days between a past date and today. " +
      "Use this when the user asks how long ago something happened, " +
      "for example how many days since they applied to a job or had an interview. " +
      "Input must be a YYYY-MM-DD date. Returns an error if the date is in the future.",
    inputSchema: {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid format. Must be YYYY-MM-DD")
        .refine(
          (val) => {
            const d = new Date(val);
            return (
              !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val
            );
          },
          { message: "Not a real calendar date (e.g. 2026-02-30)" },
        )
        .transform((val) => new Date(val))
        .describe("A past date in YYYY-MM-DD format, e.g. 2026-09-01"),
      // TODO: one field called `date`
    },
  },
  async ({ date }) => {
    const msInDay = 24 * 60 * 60 * 1000;
    // const currentDay = Date.now();
    const daysPassed = Math.floor((Date.now() - date.getTime()) / msInDay);
    if (daysPassed < 0) {
      return {
        content: [
          {
            type: "text",
            text: `${date.toISOString().slice(0, 10)} is in the future. Please provide past dates`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `${daysPassed} days since ${date.toISOString().slice(0, 10)}`,
        },
      ],
    };

    // TODO: logic
  },
);
// 4. Connect over stdio: Claude Desktop launches this file as a child process
//    and talks JSON-RPC over stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

// 5. Log to STDERR only. stdout belongs to the protocol (Day 1, Part 2).
console.error("jobhunt-mcp running on stdio");
