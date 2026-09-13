#!/usr/bin/env node
/**
 * A budget-scoped proxy for the FetchSandbox MCP server.
 *
 * It speaks MCP on both sides: your agent connects to this, this connects to
 * the real server. Nothing about FetchSandbox changes, and the same wrapper
 * fits any stdio MCP server whose work is countable.
 *
 * ── WHAT A UNIT IS ────────────────────────────────────────────────────────
 * A completed RUN, charged to the TOOL that was called.
 *
 * Counting `tools/call` is the obvious answer and it is wrong: `list_specs` and
 * a five-step `quickrun` are both one call. Counting a field in the reply is
 * also wrong, and that one we learned the hard way — v1 looked for
 * `flow_run_id`, `prove_fix` does not return it, so the most expensive
 * operation in the product was free while `quickrun` was metered. Keying on the
 * response shape forces every producer to keep a field it never promised.
 *
 * ── RESERVATIONS, NOT COUNTING AFTER THE FACT ─────────────────────────────
 * A slot is HELD when a call is forwarded, and committed or released when it
 * resolves. Counting afterwards cannot bound concurrency: two simultaneous
 * calls both read the same spent total, both pass the check, and a budget of
 * two spends three.
 *
 *     available = budget - spent - reserved - unknown
 *
 * ── THE THREE OUTCOMES, INCLUDING THE ONE THAT MATTERS ────────────────────
 *   accepted  reply arrived, no error      -> committed, charged
 *   failed    reply arrived with an error  -> released, not charged
 *   unknown   no reply within the deadline -> slot HELD, flagged
 *
 * `unknown` is the interesting state and the easy one to get wrong. A lost
 * response does not mean the work did not happen — it means we cannot see
 * whether it did. Releasing the slot would let an agent re-run something that
 * already ran; charging it would bill for work that may never have started. So
 * the slot stays held and the operation is reported for reconciliation.
 *
 * ── RECONCILIATION ────────────────────────────────────────────────────────
 * FetchSandbox keeps a server-side record of every call, readable without
 * credentials at /api/sandboxes/{id}/logs. That is evidence independent of
 * anything this process saw, which is what makes an unknown resolvable at all
 * rather than a permanent maybe.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const BUDGET = Number.parseInt(process.env.FS_BUDGET_RUNS ?? "2", 10);
const DEADLINE_MS = Number.parseInt(process.env.FS_RUN_DEADLINE_MS ?? "300000", 10);
const BASE = (process.env.FETCHSANDBOX_BASE_URL ?? "https://fetchsandbox.com").replace(/\/+$/, "");
const UPSTREAM_CMD = process.env.FS_UPSTREAM_CMD ?? "npx";
const UPSTREAM_ARGS = (process.env.FS_UPSTREAM_ARGS ?? "-y,fetchsandbox-mcp@latest").split(",");

const RUN_PRODUCING = new Set([
  "quickrun", "run_workflow", "run_all_workflows", "verify_behavior", "prove_fix",
]);

let spent = 0;
/** id -> {tool, at, timer} for calls forwarded and not yet resolved. */
const reserved = new Map();
/** Operations we could not observe the outcome of. Slots stay held. */
const unknown = [];

const log = (m) => process.stderr.write(`[budget-proxy] ${m}\n`);
const snapshot = () => ({
  budget: BUDGET, spent, reserved: reserved.size, unknown: unknown.length,
  available: Math.max(0, BUDGET - spent - reserved.size - unknown.length),
});

const upstream = spawn(UPSTREAM_CMD, UPSTREAM_ARGS, { stdio: ["pipe", "pipe", "inherit"] });
upstream.on("exit", (code) => process.exit(code ?? 0));

const answered = new Set();          // ids this proxy replied to itself
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const asResult = (id, obj) => ({
  jsonrpc: "2.0", id,
  result: { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] },
});

const RECONCILE_TOOL = {
  name: "reconcile_unknown",
  description:
    "Ask FetchSandbox whether an operation whose reply was lost actually ran. Reads the " +
    "server-side call log, which is evidence independent of anything this session saw. " +
    "Use it when budget_status reports an unknown operation, before assuming either way.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/**
 * Did work happen in the window we lost sight of?
 *
 * The reply is gone, so the sandbox id is gone with it — we search instead of
 * looking up. Sandboxes are filtered to the spec the call named, then their
 * logs are read for rows inside the window. A row there was written by the
 * server, not by us, which is the whole point: an unknown is only resolvable
 * because someone other than the client kept a record.
 */
async function reconcile(op) {
  const out = { tool: op.tool, since: op.at, evidence: [], verdict: "unresolved" };
  try {
    const listed = await fetch(`${BASE}/api/sandboxes`, { signal: AbortSignal.timeout(20000) });
    const body = await listed.json();
    const all = Array.isArray(body) ? body : (body.sandboxes ?? body.items ?? []);
    // Narrow to the spec the call named. Without that we would be searching 81
    // sandboxes, and a capped search over an unnarrowed list is worse than no
    // search: it reports "not found" when the truth is "I did not look there".
    // That is exactly what this returned on its first run — the sandbox holding
    // the evidence was 56th, the cap was 8, and the verdict was confident and
    // wrong.
    const matches = op.spec
      ? all.filter((s) => `${s.slug ?? ""}${s.spec_name ?? ""}`.toLowerCase().includes(op.spec.toLowerCase()))
      : all;
    const CAP = 12;
    if (matches.length > CAP) {
      out.verdict = `cannot determine — ${matches.length} candidate sandboxes, too many to search`;
      out.searched = 0;
      return out;
    }
    const candidates = matches;
    out.searched = candidates.length;
    for (const sb of candidates) {
      const r = await fetch(`${BASE}/api/sandboxes/${sb.id}/logs?limit=50`, { signal: AbortSignal.timeout(20000) });
      const lb = await r.json();
      const rows = Array.isArray(lb) ? lb : (lb.logs ?? lb.items ?? []);
      for (const row of rows) {
        if (row.timestamp && row.timestamp >= op.at) {
          out.evidence.push({
            sandbox_id: sb.id, flow_run_id: row.flow_run_id ?? null,
            at: row.timestamp, call: `${row.method} ${row.path}`, status: row.response_status,
          });
        }
      }
    }
    out.verdict = out.evidence.length
      ? "it ran — see evidence"
      : (out.searched
          ? `no server-side record in the window (searched ${out.searched} sandbox(es))`
          : "cannot determine — nothing to search");
  } catch (e) {
    out.verdict = `could not reach FetchSandbox to check: ${e.name}`;
  }
  return out;
}

/** A tool the agent can call to plan, rather than discovering the wall. */
const BUDGET_TOOL = {
  name: "budget_status",
  description:
    "How much run budget is left. A run is one completed quickrun, run_workflow, " +
    "run_all_workflows, verify_behavior or prove_fix. Discovery and listing are free. " +
    "Call this before planning work so you spend what you have deliberately.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function onUnknown(id) {
  const held = reserved.get(id);
  if (!held) return;
  reserved.delete(id);
  unknown.push({ tool: held.tool, spec: held.spec, at: held.at, id });
  log(`UNKNOWN ${held.tool} — no reply in ${DEADLINE_MS}ms; slot held, needs reconciliation`);
}

// ── agent → upstream ────────────────────────────────────────────────────────
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { upstream.stdin.write(line + "\n"); return; }

  if (msg.method === "tools/call" && msg.params?.name === "budget_status") {
    answered.add(msg.id);
    send(asResult(msg.id, { ...snapshot(), unknown_operations: unknown }));
    return;
  }

  if (msg.method === "tools/call" && msg.params?.name === "reconcile_unknown") {
    answered.add(msg.id);
    Promise.all(unknown.map(reconcile))
      .then((r) => send(asResult(msg.id, { checked: r.length, results: r })))
      .catch((e) => send(asResult(msg.id, { error: String(e) })));
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name ?? "";
    if (RUN_PRODUCING.has(name)) {
      const s = snapshot();
      if (s.available <= 0) {
        answered.add(msg.id);
        log(`refused ${name} — ${JSON.stringify(s)}`);
        send({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text:
            `Show this to the user:\n\n` +
            `Budget spent. ${spent} of ${BUDGET} run(s) used` +
            (reserved.size ? `, ${reserved.size} in flight` : "") +
            (unknown.length ? `, ${unknown.length} unresolved` : "") + `.\n\n` +
            `"${name}" would start another run, which is not authorised. Nothing was ` +
            `sent to FetchSandbox and no run was started, so there is no partial state ` +
            `to clean up.\n\n` +
            `Report the work done so far and stop. Do not retry this call.` }] },
        });
        return;
      }
      // Hold the slot BEFORE forwarding, so a concurrent call sees it taken.
      reserved.set(msg.id, {
        tool: name, spec: msg.params?.arguments?.spec_slug ?? null,
        at: new Date().toISOString(),
        timer: setTimeout(() => onUnknown(msg.id), DEADLINE_MS),
      });
    }
  }
  upstream.stdin.write(JSON.stringify(msg) + "\n");
});

// ── upstream → agent ────────────────────────────────────────────────────────
createInterface({ input: upstream.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }

  if (msg.id !== undefined && answered.has(msg.id)) { answered.delete(msg.id); return; }

  // Advertise budget_status alongside the real tools.
  if (msg.result?.tools && Array.isArray(msg.result.tools)) {
    msg.result.tools = [...msg.result.tools, BUDGET_TOOL, RECONCILE_TOOL];
  }

  const held = reserved.get(msg.id);
  if (held) {
    clearTimeout(held.timer);
    reserved.delete(msg.id);
    const failed = msg.error !== undefined || msg.result?.isError === true;
    if (failed) {
      log(`${held.tool} failed upstream — slot released, not charged`);
    } else {
      spent += 1;
      const t = msg.result?.content?.[0]?.text ?? "";
      const m = /"flow_run_id"\s*:\s*"([^"]+)"/.exec(t);
      log(`${held.tool}${m ? " " + m[1] : ""} — ${JSON.stringify(snapshot())}`);
      // So the agent can plan from the snapshot rather than discover the wall.
      if (typeof t === "string" && t.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(t);
          parsed.budget = snapshot();
          msg.result.content[0].text = JSON.stringify(parsed, null, 2);
        } catch { /* leave a non-JSON result untouched */ }
      }
    }
  }
  process.stdout.write(JSON.stringify(msg) + "\n");
});

export { snapshot, BASE };
