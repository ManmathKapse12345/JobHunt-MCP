// The approval panel's own script, run in a simulated browser against a fake host: the
// MCP Apps handshake, rendering the pending change, and what a click sends back.
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_APP_HTML } from "../../src/tools/approval-app-html.js";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

// The panel in a frame whose parent is our fake host.
async function openPanel() {
  // Off by default in happy-dom; the panel is our own script.
  win = new Window({ settings: { enableJavaScriptEvaluation: true } });
  const sent: Msg[] = [];
  const host = { postMessage: (m: Msg) => sent.push(m) };
  Object.defineProperty(win, "parent", { value: host });
  win.document.write(APPROVAL_APP_HTML);
  await win.happyDOM.waitUntilComplete();
  const deliver = async (data: Msg) => {
    win!.dispatchEvent(new win!.MessageEvent("message", { data, source: host as never }));
    await new Promise((r) => setTimeout(r, 0));
  };
  const last = (method: string) => sent.filter((m) => m.method === method).at(-1);
  return { sent, deliver, last, doc: win.document };
}

const batch = {
  id: "0b0b0b0b-0000-4000-8000-000000000000",
  token: "t".repeat(43),
  kind: "batch",
  title: "2 changes to your tracker:",
  items: [{ summary: 'Change the status of "SDE" at Stripe: applied -> interview.' }, { summary: '<img src=x onerror="alert(1)">' }],
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

async function ready() {
  const p = await openPanel();
  const init = p.last("ui/initialize")!;
  expect(init.params).toMatchObject({ protocolVersion: "2026-01-26", appInfo: { name: "jobhunt-approval" } });
  await p.deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake" }, hostCapabilities: {}, hostContext: { theme: "dark" } } });
  return p;
}

describe("approval panel", () => {
  it("handshake: initialize, then initialized, and it follows the host's theme", async () => {
    const p = await ready();
    expect(p.last("ui/notifications/initialized")).toBeDefined();
    expect(p.doc.documentElement.dataset.theme).toBe("dark");
  });

  it("shows each change with a ticked checkbox, as text only", async () => {
    const p = await ready();
    await p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { approval: batch } } });
    expect(p.doc.querySelector("h1")!.textContent).toBe("2 changes to your tracker:");
    const boxes = [...p.doc.querySelectorAll("input[type=checkbox]")] as unknown as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    // An email-derived name that looks like HTML stays text.
    expect(p.doc.querySelector("img")).toBeNull();
    expect(p.doc.body.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("Apply sends the ticked items to decide_approval, then shows the outcome", async () => {
    const p = await ready();
    await p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { approval: batch } } });
    const boxes = [...p.doc.querySelectorAll("input[type=checkbox]")] as unknown as HTMLInputElement[];
    boxes[0]!.click(); // untick the first
    (p.doc.querySelector("button.primary") as unknown as HTMLButtonElement).click();
    const call = p.last("tools/call")!;
    expect(call.params).toEqual({ name: "decide_approval", arguments: { id: batch.id, token: batch.token, decision: "approve", items: [1] } });

    await p.deliver({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        content: [{ type: "text", text: "The user approved." }],
        structuredContent: {
          decision: {
            kind: "approved",
            message: "Applied 1 of 2 changes; 1 not ticked.",
            items: [{ outcome: "skipped", summary: "a", message: "Not ticked." }, { outcome: "applied", summary: "b", message: "ok" }],
          },
        },
      },
    });
    expect(p.doc.querySelector("h1")!.textContent).toBe("Approved");
    expect(p.doc.body.textContent).toContain("Applied 1 of 2 changes; 1 not ticked.");
  });

  it("Reject sends a reject", async () => {
    const p = await ready();
    await p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { approval: batch } } });
    (p.doc.querySelectorAll("button")[1] as unknown as HTMLButtonElement).click();
    expect(p.last("tools/call")!.params).toMatchObject({ arguments: { decision: "reject" } });
  });

  it("a result with nothing to approve shows its text", async () => {
    const p = await ready();
    await p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Nothing to change." }] } });
    expect(p.doc.body.textContent).toContain("Nothing to change.");
    expect(p.doc.querySelector("button")).toBeNull();
  });

  it("ignores messages that don't come from the host frame", async () => {
    const p = await ready();
    win!.dispatchEvent(
      new win!.MessageEvent("message", {
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { approval: batch } } },
        source: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(p.doc.querySelector("input")).toBeNull();
  });
});
