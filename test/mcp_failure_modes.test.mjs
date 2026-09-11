// Live failure-mode coverage: every failure scenario for the 6 launch specs,
// driven through the REAL MCP tool loop against a REAL backend — the way
// Claude/Cursor invokes it (user asks -> agent calls run_workflow with a
// scenario -> backend reproduces it -> receipt comes back).
//
// This is NOT hermetic: it needs a live backend. Set FETCHSANDBOX_BASE_URL to
// point the MCP client at it (e.g. a local uvicorn). Skipped otherwise so the
// default `npm test` stays fast + offline.
//
// Proves, per spec: each failure mode is INVOCABLE via MCP, is ACCEPTED (not
// silently dropped), RUNS, and returns a REAL receipt (share_url) — i.e. valid,
// durable, reliable through the interface a user actually drives.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const BASE = process.env.FETCHSANDBOX_BASE_URL;
const SPECS = ["stripe", "clerk", "descope", "resend", "twilio", "agentmail"];
const SKIP = BASE ? false : "set FETCHSANDBOX_BASE_URL to a live backend to run";

async function api(path, opts) {
  const r = await fetch(`${BASE}${path}`, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

function scenarioNames(raw) {
  return (raw || [])
    .map((s) => (typeof s === "string" ? s : s?.name || s?.id))
    .filter(Boolean);
}

let client;
before(async () => {
  if (!BASE) return;
  const { server } = await import("../dist/index.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "failure-mode-harness", version: "0.0.0" }, { capabilities: {} });
  await client.connect(ct);
});

for (const slug of SPECS) {
  test(`${slug}: every failure mode reproduces via MCP run_workflow`, { skip: SKIP }, async () => {
    // 1. resolve the spec + create a sandbox (setup — like import_spec does)
    const specs = (await api("/api/specs")).body;
    const spec = (specs || []).find((s) => s.slug === slug);
    assert.ok(spec, `${slug} is not loaded by the backend`);

    const cr = await api("/api/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec_id: spec.id }),
    });
    assert.equal(cr.status, 200, `${slug} create sandbox -> ${cr.status}`);
    const sandboxId = cr.body.id;
    let scenarios = scenarioNames(cr.body.scenarios);
    if (scenarios.length === 0) {
      const g = await api(`/api/sandboxes/${sandboxId}`);
      scenarios = scenarioNames(g.body?.scenarios);
    }

    // 2. pick a workflow via the MCP list_workflows tool
    const lwRes = await client.callTool({ name: "list_workflows", arguments: { spec_id: spec.id } });
    assert.notEqual(lwRes.isError, true, `${slug} list_workflows errored: ${lwRes.content?.[0]?.text}`);
    const lw = JSON.parse(lwRes.content[0].text);
    const wf = (lw.workflows || [])[0]?.id;
    assert.ok(wf, `${slug} has no runnable workflow`);

    // 3. run EVERY non-default failure mode via the MCP run_workflow tool
    const modes = scenarios.filter((s) => s !== "default");
    assert.ok(modes.length > 0, `${slug} declares no failure scenarios`);
    const broken = [];
    for (const scen of modes) {
      const res = await client.callTool({
        name: "run_workflow",
        arguments: { sandbox_id: sandboxId, workflow_name: wf, scenario: scen },
      });
      if (res.isError) {
        broken.push(`${scen}: tool error -> ${res.content?.[0]?.text?.slice(0, 90)}`);
        continue;
      }
      const payload = JSON.parse(res.content[0].text);
      if (!payload.share_url || !String(payload.share_url).startsWith("http")) {
        broken.push(`${scen}: ran but produced no receipt (share_url)`);
      }
    }

    console.log(`  ${slug}: ${modes.length - broken.length}/${modes.length} failure modes reproduced via MCP (workflow=${wf})`);
    assert.deepEqual(
      broken, [],
      `${slug} failure modes that did NOT reproduce reliably via MCP: ${JSON.stringify(broken, null, 2)}`,
    );
  });
}
