// The REAL brownfield flow, all MCP tools, no sandbox setup, no CLAUDE.md:
//   guide(prompt) -> quickrun(spec, workflow, scenario) -> verify_behavior(...)
// This is what a user with a brownfield app + a bare prompt actually triggers.
// Run against a live backend (prod or local) via FETCHSANDBOX_BASE_URL.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const BASE = process.env.FETCHSANDBOX_BASE_URL;
const SKIP = BASE ? false : "set FETCHSANDBOX_BASE_URL to a live backend to run";

let client;
before(async () => {
  if (!BASE) return;
  const { server } = await import("../dist/index.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "brownfield-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(ct);
});

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, text: res.content?.[0]?.text, json: safe(res.content?.[0]?.text) };
}
function safe(t) { try { return JSON.parse(t); } catch { return null; } }

test("brownfield: bare prompt -> reproduce (and prove, where deployed)", { skip: SKIP }, async () => {
  // 1. the user's prompt, routed
  const guide = await callTool("guide", {
    intent: "test my stripe webhook handler for the duplicate-webhook bug and prove the fix",
  });
  assert.equal(guide.isError, false, `guide errored: ${guide.text}`);
  const g = guide.json;
  const spec = g.spec, workflow = g.workflow;
  const bug = g.matched_bug_pattern || {};
  const scenario = g.scenario || bug.reproduce_with?.scenario || "webhook_retries";
  console.log(`\n  guide  -> spec=${spec} workflow=${workflow} scenario=${scenario} bug=${bug.id}`);
  assert.equal(spec, "stripe");
  assert.ok(workflow, "guide must resolve a workflow");

  // 2. REPRODUCE — one call, no sandbox setup
  const run = await callTool("quickrun", { spec_slug: spec, workflow_name: workflow, scenario });
  assert.equal(run.isError, false, `quickrun errored: ${run.text}`);
  const r = run.json;
  console.log(`  quickrun -> status=${r.status} sandbox=${r.sandbox_id} flow_run_id=${r.flow_run_id}`);
  console.log(`             receipt: ${r.share_url}`);
  assert.ok(r.sandbox_id && r.flow_run_id, "quickrun returns ids to chain");

  // 3. PROVE — only works where the sim images + block are deployed
  const prove = await callTool("verify_behavior", {
    bug_pattern_id: bug.id || "webhook_duplicate_side_effect",
    sandbox_id: r.sandbox_id,
    flow_run_id: r.flow_run_id,
  });
  if (prove.isError) {
    console.log(`  verify_behavior -> NOT AVAILABLE here: ${String(prove.text).slice(0, 90)}`);
    console.log(`  (reproduce works on this backend; prove needs the sim block + Docker images deployed)`);
  } else {
    const p = prove.json;
    console.log(`  verify_behavior -> confirmed=${p.confirmed}`);
    for (const probe of p.probes || []) {
      console.log(`      ${(probe.name || "").slice(0, 44).padEnd(44)} buggy=${probe.buggy_status} fixed=${probe.fixed_status}`);
    }
    assert.equal(p.confirmed, true);
  }
});
