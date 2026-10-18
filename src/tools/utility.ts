import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate } from "../dates.js";

// Small tools that don't touch the database.
export function registerUtilityTools(server: McpServer) {
  // The LLM reads the description to decide WHEN to call it,
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
}
