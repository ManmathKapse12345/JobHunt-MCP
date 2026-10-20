import http from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "../config.js";
import { log } from "../log.js";
import { createApprovalHandler, isApprovalPath, page, send, sendFailure } from "./approval-page.js";
import { setApprovalBaseUrl } from "./links.js";

// stdio mode: serve the approval page (approval-page.ts) on this computer only.
// It listens on 127.0.0.1, so nothing outside this computer can reach it, and needs no
// sign-in. (The deployed server, src/http.ts, serves the same page behind a sign-in.)

const plog = log.child({ component: "approval-page" });

export function startApprovalServer(): Promise<void> {
  let handle = createApprovalHandler({ origins: localOrigins(env.APPROVAL_PORT) });
  setApprovalBaseUrl(`http://127.0.0.1:${env.APPROVAL_PORT}`);

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (!isApprovalPath(pathname)) return send(res, 404, page("Not found", ""));
    handle(req, res).catch((err) => sendFailure(res, err));
  });
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Claude Desktop and Claude Code can each run a copy of this server. All approval
        // state lives in the database, so the copy that owns the port can serve every link.
        plog.info({ port: env.APPROVAL_PORT }, "port in use, another jobhunt-mcp is serving approval links");
      } else {
        plog.error({ err }, "could not start");
      }
      resolve();
    });
    server.listen(env.APPROVAL_PORT, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port; // differs when APPROVAL_PORT=0
      handle = createApprovalHandler({ origins: localOrigins(port) });
      setApprovalBaseUrl(`http://127.0.0.1:${port}`);
      server.unref(); // let the process exit when Claude disconnects
      plog.info({ url: `http://127.0.0.1:${port}` }, "approval page listening");
      resolve();
    });
  });
}

function localOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}
