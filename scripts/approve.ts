// Approving a change from a terminal command (gmail:propose, linkedin:import): serve the
// approval page, open it, wait for the decision and print what happened. The decision is
// made on the page (this process's, or another jobhunt-mcp's on the same port: either way
// it lands in pending_actions).
import { spawn } from "node:child_process";
import { startApprovalServer } from "../src/hitl/approval-server.js";
import type { Prepared } from "../src/hitl/actions.js";
import { createApprovalLink } from "../src/hitl/requireApproval.js";
import { getPendingAction } from "../src/repos/pending-actions.js";

// True if something was applied.
export async function approveInBrowser(batch: Prepared): Promise<boolean> {
  await startApprovalServer();
  const link = await createApprovalLink(batch);
  console.log(`${batch.summary}\n\nNothing has changed yet. Tick what to apply on this page:\n\n  ${link.url}\n`);
  openBrowser(link.url);
  console.log(`Waiting for your decision (the link expires at ${link.expiresAt.toLocaleTimeString()})...`);

  const decided = await waitForDecision(link.id, link.expiresAt);
  if (!decided || decided.status === "expired") {
    console.log("\nThe link expired. Nothing was changed; run the command again.");
    return false;
  }
  if (decided.status === "rejected") {
    console.log("\nRejected. Nothing was changed.");
    return false;
  }
  if (decided.error) {
    console.log(`\nNot applied: ${decided.error}`);
    return false;
  }
  const result = decided.result as { message: string; items: Array<{ summary: string; outcome: string; message: string }> };
  console.log(`\n${result.message}`);
  for (const it of result.items) {
    console.log(`  ${it.outcome.padEnd(8)} ${it.summary}${it.outcome === "failed" ? `\n           ${it.message}` : ""}`);
  }
  return result.items.some((it) => it.outcome === "applied");
}

async function waitForDecision(id: string, expiresAt: Date) {
  while (Date.now() < expiresAt.getTime() + 5_000) {
    const row = await getPendingAction(id);
    if (row && row.status !== "pending") return row;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return undefined;
}

// Best effort; the URL is printed anyway. rundll32 avoids cmd.exe, which would cut the
// URL at its first "&".
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
