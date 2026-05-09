#!/usr/bin/env node
/**
 * Track 3.3 — multi-spec stage smoke. Imports 10 popular real-world
 * OpenAPI URLs and reports which match a bundled curated sandbox,
 * which produce auto-enumerated workflows, and which break.
 *
 * Run after deploys to catch regressions:
 *   node mcp/scripts/smoke-popular.mjs
 */
const BASE = process.env.FETCHSANDBOX_BASE_URL || "https://stage.fetchsandbox.com";

// Only URLs verified to return 200 today. Many vendors have moved their
// OpenAPI specs behind login walls or stopped publishing them entirely
// (Notion, Linear, Anthropic, Vercel) — that's a launch-day talking point.
const SPECS = [
  { label: "Stripe",   url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json" },
  { label: "GitHub",   url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json" },
  { label: "Twilio",   url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/yaml/twilio_messaging_v1.yaml" },
  { label: "Discord",  url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json" },
  { label: "Petstore", url: "https://petstore3.swagger.io/api/v3/openapi.json" },
  // Slack ships Swagger 2.0 (not OpenAPI 3.x) → expect 400. Useful
  // negative case to keep proving the rejection works.
  { label: "Slack(2.0)", url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json", expect_fail: true },
];

const headers = {
  "content-type": "application/json",
  "x-mcp-session-id": `popular-smoke-${Date.now().toString(36)}`,
};

async function probe(spec) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/mcp/import-spec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: spec.url }),
    });
    const ms = Date.now() - t0;
    const body = await res.json();
    return { ok: res.ok, status: res.status, ms, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  }
}

console.log(`▶ Track 3.3 multi-spec smoke against ${BASE}\n`);
let passed = 0;
let failed = 0;
let matched = 0;
const failures = [];

for (const spec of SPECS) {
  process.stdout.write(`${spec.label.padEnd(12)} `);
  const r = await probe(spec);
  const expectFail = spec.expect_fail === true;
  const ok = r.ok && !expectFail;
  const okFail = !r.ok && expectFail; // expected-to-fail and did
  if (ok) {
    const m = r.body.matched_bundled ? " (BUNDLED)" : "";
    console.log(`✓ ${r.status} ${r.ms}ms — ${r.body.endpoint_count} endpoints, ${r.body.workflow_count} workflows${m}`);
    passed++;
    if (r.body.matched_bundled) matched++;
  } else if (okFail) {
    console.log(`✓ ${r.status} ${r.ms}ms — rejected as expected: ${String(r.body?.detail ?? "").slice(0, 80)}`);
    passed++;
  } else {
    const detail = r.body?.detail ?? r.error ?? "unknown";
    console.log(`✗ ${r.status} ${r.ms}ms — ${String(detail).slice(0, 100)}`);
    failed++;
    failures.push({ label: spec.label, url: spec.url, status: r.status, detail });
  }
}

console.log(`\nSummary: ${passed} pass / ${failed} fail / ${matched} matched-bundled / ${SPECS.length} total`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.label} (${f.status}): ${String(f.detail).slice(0, 200)}`);
    console.log(`    URL: ${f.url}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
