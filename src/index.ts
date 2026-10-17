import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isoDate, todayIso } from "./dates.js";
import { addApplication, DuplicateApplicationError, STATUSES } from "./store.js";

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
      date: isoDate
        .transform((val) => new Date(val))
        .describe("A past date in YYYY-MM-DD format, e.g. 2026-09-01"),
    },
  },
  async ({ date }) => {
    const msInDay = 24 * 60 * 60 * 1000;
    const now = new Date();
    // Today's LOCAL calendar date, placed at midnight UTC, the same reference point as `date`.
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const daysPassed = (todayUtc - date.getTime()) / msInDay;
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

  },
);

server.registerTool(
  "add_application",
  {
    title: "Add Job Application",
    description:
      "Save a new job application to the user's job-hunt tracker. " +
      "Call this when the user says they applied to a job, or wants to track one they plan to apply to. " +
      "Only include details the user actually gave; never invent a URL, date, or notes. " +
      "If the company or role is unclear, ask the user before calling. " +
      "Fails if an application for the same company and role already exists.",
    inputSchema: {
      company: z.string().trim().min(1).describe("Company name, e.g. Stripe"),
      role: z.string().trim().min(1).describe("Job title, e.g. Backend Engineer"),
      status: z
        .enum(STATUSES)
        .default("applied")
        .describe("Current stage. Use 'wishlist' if they have not applied yet."),
      appliedOn: isoDate
        .optional()
        .describe("Date they applied, YYYY-MM-DD. Omit if they applied today."),
      url: z.url().optional().describe("Link to the job posting, if the user gave one"),
      notes: z.string().optional().describe("Anything else the user mentioned, e.g. referral"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ company, role, status, appliedOn, url, notes }) => {
    try {
      const app = await addApplication({
        company,
        role,
        status,
        appliedOn: appliedOn ?? (status === "applied" ? todayIso() : undefined),
        url,
        notes,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Saved: ${app.role} at ${app.company} (status: ${app.status}` +
              (app.appliedOn ? `, applied on ${app.appliedOn}` : "") +
              `). id: ${app.id}`,
          },
        ],
      };
    } catch (err) {
      if (err instanceof DuplicateApplicationError) {
        return {
          content: [{ type: "text", text: `${err.message} Not saved again.` }],
          isError: true,
        };
      }
      throw err; // unexpected (broken data file, disk error): let the SDK report it
    }
  },
);
// 4. Connect over stdio: Claude Desktop launches this file as a child process
//    and talks JSON-RPC over stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

// 5. Log to STDERR only. stdout belongs to the protocol (Day 1, Part 2).
console.error("jobhunt-mcp running on stdio");
