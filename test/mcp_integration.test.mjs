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
  if (path.endsWith("/api/mcp/validate_integration")) {
    const body = httpCalls.at(-1)?.body;
    if (body?.execute) return {job_id: "receipt_job", status: "running"};
    if (body?.providers?.length) return {step: "handover", next_action: "inspect_app_then_configure_receipt_suite",
      next_tool_call: null, missing_configuration: ["webhook_url"], legs: {paddle: {base_url: "https://twin.test"}},
      application_setup_policy: {replit_private_development_url: {steps: ["restore privacy"]}}};
    if (body?.suite) return {step: "configure_app", next_action: "configure_app_then_execute",
      setup_actions_before_execute: ["preflight", "bind twins", "save secrets"], next_tool_call: null};
    return {};
  }
  if (path.endsWith("/api/mcp/jobs/receipt_job")) {
    return {status: "done", suite: "receipt_delivery_v1",
      verdict: "inconclusive", app_verified: false,
      checks: ["R1", "R2", "R3", "R4"].map(id => ({id, status: "unmeasured"})),
      message_for_user: "The configured webhook URL returned HTTP 404. Check that its host and path match the app's actual webhook route.",
      receipt_url: "/runs/sb_receipt?flow=vr_receipt",
      execution_diagnostics: {delivery_attempts: 1, successful_deliveries: 0,
        failed_deliveries: [{case: "same_customer", stage: "first",
          code: "webhook_route_not_found", http_status: 404}],
        checkpoints_recorded: 0, checkpoints_expected: 6,
        missing_checkpoints: ["same_customer.first"], error_codes: [],
        summary: "The configured webhook URL returned HTTP 404. Check that its host and path match the app's actual webhook route."},
      manifest: {session_id: "vs_receipt"}, evidence: {raw: "large private archive"}};
  }
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
  provider: "stripe", evidence_scope: "reference_handlers", app_verified: false,
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

test("validation exposes and forwards both halves of the failure probe loop", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "validate_integration");
  assert.ok(tool.inputSchema.properties.arm);
  assert.ok(tool.inputSchema.properties.probe);
  for (const action of ["arm", "probe"]) {
    httpCalls.length = 0;
    const res = await client.callTool({
      name: "validate_integration",
      arguments: { session_id: "vs_test", [action]: "paddle:webhook_duplicate_delivery",
        ...(action === "probe" ? { run_id: "vr_test" } : {}) },
    });
    assert.notEqual(res.isError, true);
    const call = httpCalls.find((c) => c.path === "/api/mcp/validate_integration");
    assert.ok(call);
    assert.equal(call.body.session_id, "vs_test");
    assert.equal(call.body[action], "paddle:webhook_duplicate_delivery");
    assert.equal(call.body[action === "arm" ? "probe" : "arm"], null);
    assert.equal(call.body.run_id, action === "probe" ? "vr_test" : null);
  }
});

test("hosted validation directs agents to the recommended app suite before reference tools", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "validate_integration");
  assert.ok(tool);
  assert.match(tool.description, /follow the returned `next_action`/i);
  assert.match(tool.description, /only when it is non-null and its arguments are complete/i);
  assert.match(tool.description, /never execute while host-side setup is pending/i);
  assert.match(tool.description, /do not ask the user to run a manual flow first/i);
  assert.match(tool.description, /do not substitute.*guide, quickrun, list_workflows/i);
  assert.match(tool.description, /receipt_recovery_v1 includes R1-R4/i);
  assert.match(tool.description, /secret_handoff_url/i);
  assert.match(tool.description, /PADDLE_API_KEY, RESEND_API_KEY, and PADDLE_WEBHOOK_SECRET/i);
  assert.match(tool.description, /responsible for completing this setup/i);
  assert.match(tool.description, /greenfield app.*publish a temporary test build first/i);
  assert.match(tool.description, /400 signature rejection is expected.*307\/login redirect is a blocker/i);
  assert.match(tool.description, /After the successful preflight, configure the suite/i);
  assert.match(tool.description, /execute only after the host-side setup actions are complete/i);
  assert.match(tool.description, /after every required check is held.*remove only the test secrets/i);
  assert.match(tool.description, /configure separate development\/staging credentials/i);
  assert.match(tool.description, /do not ask the human to discover endpoints/i);
  assert.match(tool.description, /report its `execution_diagnostics` field directly/i);
  assert.match(tool.description, /Paddle checkout is a separate app-owned browser flow/i);
  assert.match(tool.description, /do not imply FetchSandbox hosts the merchant's payment UI/i);
  assert.match(tool.description, /Paddle Sandbox default payment link or per-transaction override/i);
  assert.match(tool.description, /transaction creation alone is not payment proof/i);
});

test("invalid validation actions never reach the backend", async () => {
  for (const args of [{ arm: "p" }, { probe: "p" }, { session_id: "vs_test", arm: "p", probe: "p" },
    { session_id: "vs_test", probe: "p" }, { session_id: "vs_test", cancel: true },
    { session_id: "vs_test", arm: "p", run_id: "old" },
    { session_id: "vs_test", cancel: true, probe: "p", run_id: "old" }]) {
    httpCalls.length = 0;
    const res = await client.callTool({ name: "validate_integration", arguments: args });
    assert.equal(res.isError, true);
    assert.equal(httpCalls.length, 0);
  }
});

test("validation cancellation forwards the exact attempt ID", async () => {
  httpCalls.length = 0;
  const result = await client.callTool({ name: "validate_integration",
    arguments: { session_id: "vs_test", run_id: "vr_test", cancel: true } });
  assert.notEqual(result.isError, true);
  const call = httpCalls.find((c) => c.path === "/api/mcp/validate_integration");
  assert.equal(call.body.run_id, "vr_test");
  assert.equal(call.body.cancel, true);
});

test("receipt configuration and execution survive the actual MCP dispatch", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === "validate_integration");
  for (const field of ["suite", "receipt_config", "execute"]) assert.ok(tool.inputSchema.properties[field]);
  const config = {webhook_url: "https://shop.example/webhook", recipient_a: "a@example.test",
    recipient_b: "b@example.test", purchase_marker: {field: "html"}, observation_seconds: 2,
    app_version: "test-build", source_lookup_required: true};
  httpCalls.length = 0;
  const configured = await client.callTool({name: "validate_integration", arguments: {
    session_id: "vs_receipt", suite: "receipt_delivery_v1", receipt_config: config}});
  assert.notEqual(configured.isError, true);
  assert.deepEqual(httpCalls.at(-1).body.receipt_config, config);
  assert.equal(httpCalls.at(-1).body.suite, "receipt_delivery_v1");
  httpCalls.length = 0;
  const result = await client.callTool({name: "validate_integration", arguments: {
    session_id: "vs_receipt", execute: true, run_id: "vr_receipt"}});
  assert.notEqual(result.isError, true);
  assert.equal(httpCalls[0].body.execute, true);
  assert.equal(httpCalls[0].body.async_job, true);
  assert.equal(httpCalls[0].body.run_id, "vr_receipt");
  assert.ok(httpCalls.some(c => c.path.endsWith("/jobs/receipt_job")));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.app_verified, false);
  assert.equal(payload.checks.length, 4);
  assert.equal(payload.receipt_url, "/runs/sb_receipt?flow=vr_receipt");
  assert.equal(payload.manifest, undefined);
  assert.equal(payload.evidence, undefined);
  assert.equal(payload.execution_diagnostics.failed_deliveries[0].code, "webhook_route_not_found");
  assert.match(payload.message_for_user, /host and path match the app's actual webhook route/);
  assert.match(payload.execution_diagnostics.summary, /host and path match the app's actual webhook route/);
});

test("hosted MCP preserves staged handoffs and does not advertise premature execution", async () => {
  const start = await client.callTool({name: "validate_integration", arguments: {providers: ["paddle", "resend"]}});
  const started = JSON.parse(start.content[0].text);
  assert.equal(started.next_action, "inspect_app_then_configure_receipt_suite");
  assert.equal(started.next_tool_call, null);
  assert.deepEqual(started.missing_configuration, ["webhook_url"]);
  assert.ok(started.application_setup_policy.replit_private_development_url);

  const configured = await client.callTool({name: "validate_integration", arguments: {
    session_id: "vs_receipt", suite: "receipt_recovery_v1",
    receipt_config: {webhook_url: "https://shop.example/webhook", recipient_a: "a@example.test",
      recipient_b: "b@example.test", purchase_marker: {field: "html"},
      app_version: "build-1", source_lookup_required: true}}});
  const handoff = JSON.parse(configured.content[0].text);
  assert.equal(handoff.next_action, "configure_app_then_execute");
  assert.equal(handoff.next_tool_call, null);
  assert.deepEqual(handoff.setup_actions_before_execute, ["preflight", "bind twins", "save secrets"]);
});

test("invalid receipt execution is rejected before sending a request", async () => {
  for (const args of [{providers:["paddle"], execute:true},
    {session_id:"s", execute:true}, {session_id:"s", run_id:"r", execute:true, cancel:true},
    {session_id:"s", receipt_config:{webhook_url:"https://example.test"}},
    {session_id:"s", suite:"receipt_delivery_v1", execute:true, run_id:"r"}]) {
    httpCalls.length=0;
    const result=await client.callTool({name:"validate_integration", arguments:args});
    assert.equal(result.isError,true);
    assert.equal(httpCalls.length,0);
  }
});

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
  assert.equal(out.provider, "stripe", "provider identity must survive the job poll and MCP dispatcher");
  assert.equal(out.evidence_scope, "reference_handlers");
  assert.equal(out.app_verified, false);
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

test("verify_behavior preserves reference provider identity and execution errors", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    pattern_id: "notification_duplicate_side_effect",
    provider: "paddle", evidence_scope: "reference_handlers", app_verified: false,
    mode: "order_fuzz", error: "Reference handler could not start",
  });
  try {
    const out = await runVerifyBehavior({
      bug_pattern_id: "notification_duplicate_side_effect", sandbox_id: "sb_paddle",
    });
    assert.equal(out.error, "Reference handler could not start");
    assert.equal(out.provider, "paddle");
    assert.equal(out.evidence_scope, "reference_handlers");
    assert.equal(out.app_verified, false);
    assert.equal(out.confirmed, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior cannot confirm a failed result even when it also carries positive evidence", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  try {
    for (const result of [
      { ...VERIFY_RESULT, error: "A required probe failed to execute" },
      { mode: "order_fuzz", error: "Partial execution", order_fuzz: { confirmed: true } },
      { ...VERIFY_RESULT, status: "error" },
      { ...VERIFY_RESULT, probes: [{ ...VERIFY_RESULT.probes[1],
        buggy_response: { status: 409, error: "Handler disconnected" } }] },
    ]) {
      // A positive server summary cannot override a visible execution error.
      globalThis.fetch = async () => Response.json({ ...result, confirmed: true });
      const out = await runVerifyBehavior({ bug_pattern_id: "p" });
      assert.equal(out.confirmed, false, JSON.stringify(result));
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior respects a server refusal even when the available probes look positive", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  try {
    // Only the backend knows the configured probe count. A returned subset can
    // look successful while the complete configured reference was not measured.
    for (const result of [
      { ...VERIFY_RESULT, confirmed: false, probes: [VERIFY_RESULT.probes[1]] },
      { provider: "stripe", mode: "either", confirmed: false, simulations: [VERIFY_RESULT] },
      { provider: "stripe", mode: "either", confirmed: true,
        simulations: [{ ...VERIFY_RESULT, confirmed: false }] },
      { mode: "order_fuzz", confirmed: false, order_fuzz: { confirmed: true } },
    ]) {
      globalThis.fetch = async () => Response.json(result);
      const out = await runVerifyBehavior({ bug_pattern_id: "p" });
      assert.equal(out.confirmed, false, JSON.stringify(result));
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior preserves whether the backend actually saved the receipt", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  try {
    for (const receipt_attached of [false, true, undefined]) {
      globalThis.fetch = async () => Response.json({ ...VERIFY_RESULT, receipt_attached });
      const out = await runVerifyBehavior({ bug_pattern_id: "p" });
      assert.equal(out.receipt_attached, receipt_attached);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior keeps either-mode cards and cannot hide a failed or empty card", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  const classification = { origin: "both", confidence: 0.5, reason: "Ambiguous symptom" };
  try {
    for (const secondCard of [
      { mode: "producer_diff", error: "Reference producer could not start" },
      { mode: "producer_diff", probes: [] },
    ]) {
      globalThis.fetch = async () => Response.json({
        pattern_id: "p", provider: "paddle", mode: "either", classification,
        simulations: [{ ...VERIFY_RESULT, provider: "paddle" },
          { ...secondCard, provider: "paddle", classification }],
      });
      const out = await runVerifyBehavior({ bug_pattern_id: "p" });
      assert.equal(out.confirmed, false);
      assert.deepEqual(out.classification, classification);
      assert.equal(out.simulations.length, 2);
      assert.equal(out.simulations[0].confirmed, true);
      assert.equal(out.simulations[1].confirmed, false);
      assert.equal(out.simulations[1].error, secondCard.error);
      assert.deepEqual(out.simulations[1].classification, classification);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior confirms completed reference cards without claiming application verification", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    provider: "paddle", mode: "either", app_verified: true, confirmed: true,
    simulations: [{ ...VERIFY_RESULT, provider: "paddle" },
      { provider: "paddle", mode: "order_fuzz", order_fuzz: {
        confirmed: true, confirmed_by: ["idempotency"],
      } }],
  });
  try {
    const out = await runVerifyBehavior({ bug_pattern_id: "p" });
    assert.equal(out.confirmed, true);
    assert.equal(out.app_verified, false, "reference handlers cannot verify the user's app");
    assert.equal(out.evidence_scope, "reference_handlers");
    assert.equal(out.simulations.length, 2);
    assert.ok(out.simulations.every((card) => card.confirmed && card.app_verified === false));
    assert.deepEqual(out.simulations[1].confirmed_by, ["idempotency"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verify_behavior rejects confirmation when a nested card names another provider", async () => {
  const { runVerifyBehavior } = await import("../dist/tools/verify_behavior.js");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    provider: "paddle", mode: "either", confirmed: true,
    simulations: [{ ...VERIFY_RESULT, provider: "stripe" }],
  });
  try {
    const out = await runVerifyBehavior({ bug_pattern_id: "p" });
    assert.equal(out.confirmed, false);
    assert.match(out.error, /provider/i);
    assert.equal(out.provider, "paddle");
    assert.equal(out.simulations[0].provider, "stripe", "keep the mismatch inspectable");
  } finally {
    globalThis.fetch = previousFetch;
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
