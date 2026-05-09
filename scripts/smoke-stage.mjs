#!/usr/bin/env node
/**
 * Stage smoke test — exercises POST /api/mcp/import-spec against
 * https://stage.fetchsandbox.com with three real public specs, then
 * follows up with list_workflows and run_workflow on the first
 * imported sandbox to prove the full chain works.
 *
 * Run after stage deploy:
 *   node mcp/scripts/smoke-stage.mjs
 */

const BASE = process.env.FETCHSANDBOX_BASE_URL || "https://stage.fetchsandbox.com";
const SESSION_ID = `smoke-${Date.now().toString(36)}`;

const SPECS = [
  {
    label: "Stripe (large)",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },
  {
    label: "GitHub (large)",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  },
  {
    label: "Petstore (canonical small)",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
  },
];

const headers = {
  "content-type": "application/json",
  "x-mcp-session-id": SESSION_ID,
  "user-agent": "fetchsandbox-mcp-smoke/0.1.0",
};

async function importSpec(spec) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/mcp/import-spec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: spec.url, name: spec.label }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, ms, body };
}

async function listWorkflows(specId) {
  const res = await fetch(`${BASE}/api/specs/${encodeURIComponent(specId)}/workflows`, {
    headers,
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

async function runWorkflow(sandboxId, workflowName) {
  const res = await fetch(
    `${BASE}/api/sandboxes/${encodeURIComponent(sandboxId)}/workflows/${encodeURIComponent(workflowName)}/run`,
    { method: "POST", headers, body: "{}" },
  );
  return { ok: res.ok, status: res.status, body: await res.json() };
}

async function main() {
  console.log(`▶ Smoke test against ${BASE} (session ${SESSION_ID})`);
  console.log(`▶ Health check`);
  const h = await fetch(`${BASE}/api/mcp/health`, { headers });
  console.log(`  ${h.status} ${h.ok ? "OK" : "FAIL"}`);
  if (!h.ok) process.exit(1);

  let firstSandbox = null;
  for (const spec of SPECS) {
    console.log(`\n▶ import_spec: ${spec.label}`);
    const r = await importSpec(spec);
    console.log(`  ${r.status} (${r.ms}ms)`);
    if (!r.ok) {
      console.log(`  FAIL: ${JSON.stringify(r.body).slice(0, 300)}`);
      continue;
    }
    console.log(`  spec_id=${r.body.spec_id} sandbox_id=${r.body.sandbox_id}`);
    console.log(`  endpoints=${r.body.endpoint_count} workflows=${r.body.workflow_count}`);
    console.log(`  dashboard=${r.body.dashboard_url}`);
    if (!firstSandbox && r.body.workflow_count > 0) {
      firstSandbox = {
        spec_id: r.body.spec_id,
        sandbox_id: r.body.sandbox_id,
        first_workflow: r.body.workflows[0]?.name,
        label: spec.label,
      };
    }
  }

  if (firstSandbox) {
    console.log(`\n▶ list_workflows on ${firstSandbox.label}`);
    const lw = await listWorkflows(firstSandbox.spec_id);
    console.log(`  ${lw.status} workflows=${(lw.body.workflows || []).length}`);

    console.log(`\n▶ run_workflow: ${firstSandbox.first_workflow} on ${firstSandbox.label}`);
    const rw = await runWorkflow(firstSandbox.sandbox_id, firstSandbox.first_workflow);
    console.log(`  ${rw.status} status=${rw.body.status} steps=${(rw.body.steps || []).length}`);
    if (rw.body.status !== "pass") {
      console.log(`  trace: ${JSON.stringify(rw.body, null, 2).slice(0, 800)}`);
    }
  }

  console.log(`\n▶ DAU snapshot`);
  const d = await fetch(`${BASE}/api/mcp/dau`, { headers });
  console.log(`  ${d.status} ${JSON.stringify(await d.json())}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
