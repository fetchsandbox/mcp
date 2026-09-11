// TRUE end-to-end: reproduce -> prove -> the final Stripe receipt.
//
// Drives the full loop through the REAL MCP client against a REAL backend
// (+ Docker for the handler diff), then fetches the durable receipt and proves
// the buggy-vs-fixed diff actually landed in it. Nothing is asserted from a
// claim — only from the receipt on disk.
//
//   run_workflow(accept_payment, scenario=webhook_retries)   <- reproduce
//   verify_behavior(webhook_duplicate_side_effect, sandbox, flow_run_id)  <- prove
//   GET /api/snapshots/<sandbox>/<flow_run_id>                <- the receipt
//
// Skipped unless FETCHSANDBOX_BASE_URL points at a live backend.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const BASE = process.env.FETCHSANDBOX_BASE_URL;
const SKIP = BASE ? false : "set FETCHSANDBOX_BASE_URL to a live backend to run";

async function api(path, opts) {
  const r = await fetch(`${BASE}${path}`, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}

let client;
before(async () => {
  if (!BASE) return;
  const { server } = await import("../dist/index.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "e2e-reproduce-prove", version: "0.0.0" }, { capabilities: {} });
  await client.connect(ct);
});

test("Stripe reproduce -> prove -> receipt contains the buggy-vs-fixed diff", { skip: SKIP }, async () => {
  // setup: a stripe sandbox
  const specs = (await api("/api/specs")).body;
  const stripe = specs.find((s) => s.slug === "stripe");
  assert.ok(stripe, "stripe not loaded");
  const cr = await api("/api/sandboxes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec_id: stripe.id }),
  });
  assert.equal(cr.status, 200);
  const sandboxId = cr.body.id;

  // 1. REPRODUCE — run the workflow under duplicate-webhook delivery, via MCP
  const runRes = await client.callTool({
    name: "run_workflow",
    arguments: { sandbox_id: sandboxId, workflow_name: "accept_payment", scenario: "webhook_retries" },
  });
  assert.notEqual(runRes.isError, true, `run_workflow errored: ${runRes.content?.[0]?.text}`);
  const run = JSON.parse(runRes.content[0].text);
  const flowRunId = run.flow_run_id;
  assert.ok(flowRunId, "run must return a flow_run_id");

  // 2. PROVE — run the buggy-vs-fixed diff, tied to this run, via MCP
  const proveRes = await client.callTool({
    name: "verify_behavior",
    arguments: {
      bug_pattern_id: "webhook_duplicate_side_effect",
      sandbox_id: sandboxId,
      flow_run_id: flowRunId,
    },
  });
  assert.notEqual(proveRes.isError, true, `verify_behavior errored: ${proveRes.content?.[0]?.text}`);
  const prove = JSON.parse(proveRes.content[0].text);
  assert.equal(prove.confirmed, true, "the buggy-vs-fixed diff must be confirmed");

  // 3. THE RECEIPT — fetch the durable snapshot and prove the diff is IN it
  const snap = await api(`/api/snapshots/${sandboxId}/${flowRunId}`);
  assert.equal(snap.status, 200, `snapshot should exist: ${snap.status}`);
  const receipt = snap.body;

  // the reproduction is in the receipt
  const steps = receipt.workflow_result?.steps || [];
  assert.ok(steps.length > 0, "receipt must contain the workflow run (reproduction)");
  // the PROOF is in the receipt
  const sims = receipt.simulations || [];
  assert.ok(sims.length > 0, "receipt must contain the buggy-vs-fixed diff (simulations[])");

  // show the final receipt
  const probes = (sims[0].probes || sims[0].result?.probes || []);
  console.log(`\n── FINAL STRIPE RECEIPT ${flowRunId} ──`);
  console.log(`  reproduction: ${steps.length} API calls · webhook_events: ${(receipt.webhook_events || []).length}`);
  console.log(`  proof (simulations[${sims.length}]):`);
  for (const p of probes) {
    console.log(`    ${(p.name || "").slice(0, 46).padEnd(46)} buggy=${p.buggy_response?.status} fixed=${p.fixed_response?.status} ${p.verdict || ""}`);
  }
});
