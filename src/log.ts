import pino from "pino";

// Structured logs: one JSON object per line, always on STDERR. In stdio mode stdout carries
// the MCP protocol, so a single stray log line there would break the client.
//   {"level":"info","time":"2026-10-20T11:02:03.456Z","component":"http","msg":"listening","port":3000}
// Read them with `npm run dev | npx pino-pretty` or filter with jq. Claude Desktop keeps
// stderr in its MCP log file; Render shows it in the service logs.
//
// LOG_LEVEL (trace|debug|info|warn|error|fatal|silent) is applied by config.ts once .env
// is loaded; until then this reads the process environment directly.
export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "jobhunt-mcp" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Never log secrets, even if one ends up in a logged object by mistake.
    redact: {
      paths: ["token", "*.token", "password", "*.password", "authorization", "*.authorization", "headers.cookie"],
      censor: "[redacted]",
    },
  },
  // sync: a log line written just before process.exit() is not lost.
  pino.destination({ dest: 2, sync: true }),
);

export type Logger = pino.Logger;
