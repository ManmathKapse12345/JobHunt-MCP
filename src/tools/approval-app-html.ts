// The in-chat approval panel (an MCP App): plain HTML and JS, no outside requests. The
// host shows it under a write tool's result, in a sandboxed frame, and relays messages:
//   panel -> host   ui/initialize, ui/notifications/initialized, ui/notifications/size-changed,
//                   tools/call decide_approval (the human's click)
//   host  -> panel  ui/notifications/tool-result (the pending change), host-context-changed
// Protocol: https://github.com/modelcontextprotocol/ext-apps (spec.types.ts).
// Everything shown comes from the tool result and is set with textContent, never as HTML.

export const APPROVAL_APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --ok: #1a7f37; --bad: #b42318; --btn: #f4f4f4; }
  :root[data-theme="dark"] { --bg: #1f1f1f; --fg: #eee; --muted: #aaa; --line: #3a3a3a; --ok: #4ac26b; --bad: #ff7b72; --btn: #2a2a2a; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #1f1f1f; --fg: #eee; --muted: #aaa; --line: #3a3a3a; --ok: #4ac26b; --bad: #ff7b72; --btn: #2a2a2a; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--font-sans, system-ui, sans-serif); }
  main { padding: 12px 14px; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
  ul { list-style: none; margin: 0 0 12px; padding: 0; }
  li { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 6px 0; white-space: pre-wrap; }
  label { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
  .tag { font-weight: 600; margin-right: 6px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--btn); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--ok); border-color: var(--ok); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .small { font-size: 12px; }
</style></head>
<body><main id="root"><p class="meta">Loading the approval...</p></main>
<script>
(() => {
  const root = document.getElementById("root");
  let nextId = 1;
  const pending = new Map();
  let approval = null; // { id, token, title, kind, items: [{ summary }], expiresAt }

  // ---------- JSON-RPC over postMessage, to the host ----------
  const send = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message || "request failed")) : p.resolve(m.result);
    }
    if (m.method === "ui/notifications/tool-result") return show(m.params);
    if (m.method === "ui/notifications/tool-cancelled") return message("Cancelled", "Nothing was changed.");
    if (m.method === "ui/notifications/host-context-changed") return applyContext(m.params);
    // Host requests we don't act on (ping, ui/resource-teardown): answer so it isn't left waiting.
    if (m.id !== undefined) send({ id: m.id, result: {} });
  });

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.dataset.theme = ctx.theme;
    const vars = ctx.styles && ctx.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (typeof v === "string") document.documentElement.style.setProperty(k, v);
  }

  // ---------- rendering (textContent only: summaries come from the database and from email) ----------
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") n.className = v; else n.setAttribute(k, v);
    for (const c of children) n.append(c);
    return n;
  };

  function message(title, text, cls) {
    root.replaceChildren(el("h1", cls ? { class: cls } : {}, title), el("p", {}, text));
  }

  function show(result) {
    approval = result && result.structuredContent && result.structuredContent.approval;
    if (!approval) {
      const text = ((result && result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\\n");
      return message(result && result.isError ? "Not done" : "Done", text || "Nothing to approve.", result && result.isError ? "bad" : "");
    }
    const batch = approval.kind === "batch";
    const list = el("ul");
    approval.items.forEach((it, i) => {
      const text = el("span", {}, it.summary);
      list.append(el("li", {}, batch ? el("label", {}, el("input", { type: "checkbox", value: String(i), checked: "" }), text) : text));
    });
    const approve = el("button", { class: "primary" }, batch ? "Apply ticked changes" : "Approve");
    const reject = el("button", {}, batch ? "Reject all" : "Reject");
    const expires = new Date(approval.expiresAt);
    root.replaceChildren(
      el("h1", {}, approval.title),
      el("p", { class: "meta" }, "Nothing has changed yet. Expires at " + expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "."),
      list,
      el("div", { class: "row" }, approve, reject),
    );
    approve.onclick = () => decide("approve");
    reject.onclick = () => decide("reject");
    if (batch) {
      const sync = () => (approve.disabled = !root.querySelector("input:checked"));
      root.querySelectorAll("input").forEach((c) => (c.onchange = sync));
    }
    const left = expires.getTime() - Date.now();
    if (left > 0) setTimeout(() => approval && message("Expired", "Nothing was changed. Ask Claude to propose it again."), left);
  }

  async function decide(decision) {
    if (!approval) return;
    const items = approval.kind === "batch" ? [...root.querySelectorAll("input:checked")].map((c) => Number(c.value)) : undefined;
    root.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
    try {
      const result = await request("tools/call", {
        name: "decide_approval",
        arguments: { id: approval.id, token: approval.token, decision, ...(items ? { items } : {}) },
      });
      approval = null;
      showDecision(result);
    } catch (err) {
      root.querySelectorAll("button, input").forEach((b) => (b.disabled = false));
      root.append(el("p", { class: "bad small" }, "Couldn't reach the server: " + err.message + ". Try again."));
    }
  }

  function showDecision(result) {
    const d = result && result.structuredContent && result.structuredContent.decision;
    if (!d) return message("Not done", ((result && result.content) || []).map((c) => c.text || "").join("\\n"), "bad");
    if (d.kind === "rejected") return message("Rejected", "Nothing was changed.");
    if (d.kind === "already") return message("Already decided", "This change is already " + d.status + ". Nothing more was done.");
    if (d.kind === "invalid") return message("Not valid any more", "This approval expired or was already used. Nothing was changed.", "bad");
    if (d.kind === "not-applied") return message("Could not apply", d.message + " Nothing was changed.", "bad");
    const label = { applied: "Applied", failed: "Not applied", skipped: "Skipped" };
    const list = el("ul");
    for (const it of d.items || []) {
      const li = el("li", {}, el("span", { class: "tag " + (it.outcome === "applied" ? "ok" : it.outcome === "failed" ? "bad" : "") }, label[it.outcome]), it.summary);
      if (it.outcome === "failed") li.append(el("div", { class: "meta" }, it.message));
      list.append(li);
    }
    root.replaceChildren(el("h1", { class: "ok" }, "Approved"), el("p", {}, d.message), list);
  }

  // ---------- size: tell the host how tall we are ----------
  const resize = () => notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(document.documentElement);

  request("ui/initialize", {
    appInfo: { name: "jobhunt-approval", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  })
    .then((r) => {
      applyContext(r && r.hostContext);
      notify("ui/notifications/initialized", {});
      resize();
    })
    .catch((err) => message("Can't show the approval here", "Use the approval link in Claude's reply instead. (" + err.message + ")", "bad"));
})();
</script></body></html>`;
