// Integration test: the real Claude/Cursor ↔ MCP loop.
//
// This drives the ACTUAL built MCP server (dist/index.js) with a REAL MCP
// Client over an in-memory channel — exactly how Claude Code / Cursor invoke
// it, minus the OS process. The backend HTTP layer is intercepted so we can
// assert what the user's request actually puts on the wire.
//
// Thinking like a QA engineer testing an agentic workflow:
//   user types  →  agent calls a tool  →  server dispatches  →  backend HTTP
//   →  response  →  agent gets a result back
//
// The load-bearing assertion: when the user asks for a FAILURE SCENARIO, that
// scenario must reach the backend. That is the exact bug that was silently
// dropped in the dispatch layer (0.3.6) and forced the happy path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── Backend interception ────────────────────────────────────────────────
const httpCalls = [];
const realFetch = globalThis.fetch;

function cannedBackendResponse(path) {
  if (path.includes("/workflows/") && path.endsWith("/run")) {
    return {
      flow_name: "accept_payment",
      flow_description: "Accept a payment and confirm the webhook",
      flow_run_id: "run_test123",
      sandbox_id: "sb_test",
      share_url: "https://fetchsandbox.com/runs/sb_test?flow=run_test123",
      passed: true,
      total_duration_ms: 42,
      steps: [{ name: "charge", description: "create charge", status: "passed" }],
    };
  }
  if (path.endsWith("/api/mcp/route")) {
    return {
      spec: "stripe",
      workflow: "accept_payment",
      scenario: "webhook_retries",
      confidence: 0.9,
      reasoning: "matched stripe + duplicate-webhook intent",
      matched_signals: [],
    };
  }
  if (path.endsWith("/api/specs")) {
    return [{
      id: "s1", name: "Stripe", slug: "stripe", version: "1",
      description: "", endpoints_count: 5, tags: [], created_at: "",
    }];
  }
  if (path.includes("/api/mcp/quickrun/")) {
    return {
      flow_name: "accept_payment", flow_description: "Accept a payment",
      flow_run_id: "run_qk1", sandbox_id: "sb_qk", passed: true,
      total_duration_ms: 30,
      steps: [{ status: "passed" }, { status: "passed" }],
      timeline_url: "https://fetchsandbox.com/runs/sb_qk?flow=run_qk1",
    };
  }
  // verify_behavior is JOB+POLL as of 0.4.7 — the simulation takes ~47-50s and
  // Cloudflare cuts an origin request at ~100s. The start call returns a
  // job_id; the result arrives from /api/mcp/jobs/{id}. The mock models both
  // legs, because a mock that answers the START call with a finished
  // simulation would keep passing after the client stopped polling at all.
  if (path.endsWith("/api/mcp/verify_behavior")) {
    return { job_id: "job_vb_1", status: "running" };
  }
  if (path.includes("/api/mcp/jobs/")) {
    return { status: "done", ...VERIFY_RESULT };
  }
  return {};
}

const VERIFY_RESULT = {
  pattern_id: "webhook_duplicate_side_effect",
  mode: "handler_diff",
  disclaimer: "reference handlers, not your code",
  probes: [
    { name: "duplicate delivery", buggy_response: { status: 200 },
      fixed_response: { status: 200 }, expected_diff_observed: true,
      verdict: "both 200" },
    { name: "how many charges?", buggy_response: { status: 409 },
      fixed_response: { status: 200 }, expected_diff_observed: true,
      verdict: "buggy 409, fixed 200" },
  ],
  duration_ms: 4272,
};

let client;

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const path = new URL(u).pathname;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* non-json */ }
    httpCalls.push({ method: init.method || "GET", path, body });
    return new Response(JSON.stringify(cannedBackendResponse(path)), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  // Connect a real MCP Client to the real built server over an in-memory pair.
  const { server } = await import("../dist/index.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "qa-harness", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
});

after(() => { globalThis.fetch = realFetch; });

// ── The tests ───────────────────────────────────────────────────────────

test("Claude/Cursor discovers the tools (tools/list)", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ["coach", "guide", "quickrun", "run_workflow", "list_specs", "verify_behavior"]) {
    assert.ok(names.includes(expected), `tool '${expected}' must be exposed`);
  }
});

test("bundled spec: quickrun runs by slug (no import) + returns ids to chain", async () => {
  httpCalls.length = 0;
  // The brownfield flow: guide resolved stripe/accept_payment; run it in one call.
  const res = await client.callTool({
    name: "quickrun",
    arguments: { spec_slug: "stripe", workflow_name: "accept_payment", scenario: "webhook_retries" },
  });
  assert.notEqual(res.isError, true, `quickrun errored: ${res.content?.[0]?.text}`);

  const call = httpCalls.find((c) => c.path.includes("/api/mcp/quickrun/"));
  assert.ok(call, "quickrun should hit the quickrun endpoint");
  assert.equal(call.path, "/api/mcp/quickrun/stripe/accept_payment", "spec + workflow go in the path");
  assert.equal(call.body?.scenario, "webhook_retries", "scenario forwarded to reproduce the failure");

  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "pass");
  assert.ok(out.sandbox_id && out.flow_run_id, "returns sandbox_id + flow_run_id to chain into verify_behavior");
  assert.ok(String(out.share_url).startsWith("https://"), "returns a receipt URL");
});

test("user proves a fix → verify_behavior forwards ids + returns the diff", async () => {
  httpCalls.length = 0;
  // After run_workflow reproduces the duplicate-webhook failure, the agent proves
  // the fix — passing the run's sandbox_id + flow_run_id so it lands on the receipt.
  const res = await client.callTool({
    name: "verify_behavior",
    arguments: {
      bug_pattern_id: "webhook_duplicate_side_effect",
      sandbox_id: "sb_test",
      flow_run_id: "run_1",
    },
  });
  assert.notEqual(res.isError, true, `verify_behavior errored: ${res.content?.[0]?.text}`);

  const call = httpCalls.find((c) => c.path.endsWith("/api/mcp/verify_behavior"));
  assert.ok(call, "verify_behavior should hit the backend");
  assert.equal(call.body?.bug_pattern_id, "webhook_duplicate_side_effect");
  assert.equal(call.body?.sandbox_id, "sb_test", "sandbox_id must be forwarded (saves diff to receipt)");
  assert.equal(call.body?.flow_run_id, "run_1", "flow_run_id must be forwarded");
  assert.equal(call.body?.async_job, true,
    "the client must opt into job+poll — without it the request holds an HTTP "
    + "connection open for ~50s and is exposed to Cloudflare's origin timeout");
  assert.ok(httpCalls.some((c) => c.path.includes("/api/mcp/jobs/")),
    "the result must come from a POLL, not from the start call");

  const out = JSON.parse(res.content[0].text);
  assert.equal(out.confirmed, true, "confirmed = expectations met AND a real divergence exists");
  assert.equal(out.probes.length, 2);
  // Probe 0 is a SANITY probe (buggy 200 == fixed 200): it matched its
  // expectation but is NOT a behavioral divergence — the old code mislabeled
  // this as diff_observed:true. Guard the honest split.
  assert.equal(out.probes[0].matched_expectation, true, "sanity probe met expectation");
  assert.equal(out.probes[0].divergent, false, "sanity probe (200==200) must NOT read as a diff");
  assert.equal(out.probes[1].buggy_status, 409); // buggy double-charges
  assert.equal(out.probes[1].fixed_status, 200); // fixed dedupes
  assert.equal(out.probes[1].divergent, true, "the real proof probe (409 vs 200) is the divergence");
});

// buggy == fixed on EVERY probe: matched its expectation, proved nothing.
const SANITY_ONLY = {
  pattern_id: "p",
  mode: "handler_diff",
  probes: [
    { name: "a", buggy_response: { status: 200 }, fixed_response: { status: 200 }, expected_diff_observed: true },
    { name: "b", buggy_response: { status: 201 }, fixed_response: { status: 201 }, expected_diff_observed: true },
  ],
};

test("guide sends what the repo actually integrates", async () => {
  // The router has a `context` field for exactly this — "repo signals so the
  // router can disambiguate an ambiguous symptom by the provider the repo
  // actually integrates — the funnel intersect, a fact rather than a guess" —
  // and guide never sent it. coach did.
  //
  // Measured 2026-09-07 against a Paddle + Resend app, on a symptom naming
  // neither provider: guide returned spec "stripe", workflow "accept_payment",
  // confidence 0.95. A confident route to the WRONG provider is worse than no
  // route, because everything downstream inherits it.
  httpCalls.length = 0;
  await client.callTool({
    name: "guide",
    arguments: { intent: "customers are seeing seats granted more than once" },
  });
  const call = httpCalls.find((c) => c.path.endsWith("/api/mcp/route"));
  assert.ok(call, "guide must hit /api/mcp/route");
  assert.equal(call.body?.intent, "customers are seeing seats granted more than once",
    "the prompt must reach the router unaltered");
  // The harness runs in the mcp package, which has no provider SDK, so the scan
  // legitimately finds nothing here. What is asserted is that the CALL SITE no
  // longer drops the field: a caller-supplied context must survive.
  httpCalls.length = 0;
  await client.callTool({
    name: "guide",
    arguments: { intent: "seats granted twice", context: { detected_specs: ["paddle"] } },
  });
  const forced = httpCalls.find((c) => c.path.endsWith("/api/mcp/route"));
  assert.deepEqual(forced.body?.context?.detected_specs, ["paddle"],
    "an explicit context must reach the router — it is a fact, not a guess");
});

test("verify_behavior against an OLD backend (no async support) still works", async () => {
  // The compatibility that lets this client ship before the deploy. A backend
  // without async support drops the unknown `async_job` field (pydantic ignores
  // extras) and answers the START call with the finished simulation. If the
  // client blindly polled for a job_id it would throw "Could not start job" on
  // every call, in every installed IDE, until the deploy landed.
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const realFetch = globalThis.fetch;
  let polled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/jobs/")) { polled = true; }
    // No job_id — the OLD shape: the simulation, inline.
    return new Response(JSON.stringify(SANITY_ONLY),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await runVerifyBehavior({ bug_pattern_id: "p" });
    assert.equal(polled, false, "must NOT poll when the backend answered inline");
    assert.equal(out.probes.length, 2, "the inline simulation must be used as-is");
    assert.equal(out.confirmed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("verify_behavior: a run of only sanity probes is NOT a confirmation", async () => {
  // Regression guard for the mislabel: if buggy == fixed on EVERY probe, the
  // pattern never manifested — confirmed must be false even though every probe
  // "matched expectation". Drives runVerifyBehavior directly with a stub.
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const realFetch = globalThis.fetch;
  // Two legs: start -> job_id, poll -> result. Same protocol as the client.
  globalThis.fetch = async (url) =>
    String(url).includes("/jobs/")
      ? new Response(JSON.stringify({ status: "done", ...SANITY_ONLY }),
                     { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ job_id: "job_sanity", status: "running" }),
                     { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await runVerifyBehavior({ bug_pattern_id: "p" });
    assert.equal(out.confirmed, false, "all-sanity run proves nothing → not confirmed");
    assert.ok(out.probes.every((p) => p.divergent === false), "no probe diverged");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("user runs a workflow WITH a failure scenario → scenario reaches the backend", async () => {
  httpCalls.length = 0;
  // What the agent sends after: "run accept_payment with duplicate webhooks"
  const res = await client.callTool({
    name: "run_workflow",
    arguments: {
      sandbox_id: "sb_test",
      workflow_name: "accept_payment",
      scenario: "webhook_retries",
    },
  });

  assert.notEqual(res.isError, true, `tool call errored: ${res.content?.[0]?.text}`);

  // THE REGRESSION GUARD — the user's scenario must be on the wire.
  const runCall = httpCalls.find(
    (c) => c.path.includes("/workflows/") && c.path.endsWith("/run"),
  );
  assert.ok(runCall, "a run request should hit the backend");
  assert.equal(
    runCall.body?.scenario,
    "webhook_retries",
    "scenario must be forwarded to the backend — this is the exact param the " +
      "dispatch layer silently dropped in 0.3.6, forcing the happy path",
  );

  // and the user gets a real receipt back
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "pass");
  assert.ok(
    typeof payload.share_url === "string" && payload.share_url.startsWith("https://"),
    "a receipt/share_url must come back to the user",
  );
});

test("user runs a workflow WITHOUT a scenario → happy path, no scenario on the wire", async () => {
  httpCalls.length = 0;
  await client.callTool({
    name: "run_workflow",
    arguments: { sandbox_id: "sb_test", workflow_name: "accept_payment" },
  });
  const runCall = httpCalls.find((c) => c.path.endsWith("/run"));
  assert.ok(runCall, "a run request should hit the backend");
  assert.equal(
    runCall.body?.scenario,
    undefined,
    "no scenario should be sent when the user didn't ask for one",
  );
});

test("user types a natural-language intent → guide forwards the exact prompt + routes it", async () => {
  httpCalls.length = 0;
  const prompt = "test my stripe integration with duplicate webhooks";
  const res = await client.callTool({ name: "guide", arguments: { intent: prompt } });

  assert.notEqual(res.isError, true, `guide errored: ${res.content?.[0]?.text}`);
  const routeCall = httpCalls.find((c) => c.path.endsWith("/api/mcp/route"));
  assert.ok(routeCall, "guide should hit the route endpoint");
  assert.equal(routeCall.body?.intent, prompt, "the user's exact prompt must be forwarded");

  const routed = JSON.parse(res.content[0].text);
  assert.equal(routed.spec, "stripe");
  assert.equal(routed.workflow, "accept_payment");
  assert.equal(routed.scenario, "webhook_retries");
});
