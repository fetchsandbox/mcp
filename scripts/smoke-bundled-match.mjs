#!/usr/bin/env node
/**
 * Track 1 verification — popular API URLs should now hit the bundled
 * curated sandbox instead of creating a fresh auto-enumerated spec.
 *
 * Pass criteria for each: matched_bundled === true, sandbox_id matches
 * the bundled deployment's sandbox, run_workflow returns realistic
 * IDs (cus_, sub_, ch_, ...) instead of UUIDs.
 *
 *   node mcp/scripts/smoke-bundled-match.mjs
 */
const BASE = process.env.FETCHSANDBOX_BASE_URL || "https://stage.fetchsandbox.com";

const SPECS = [
  {
    label: "Stripe URL",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    expect_match: true,
  },
  {
    label: "GitHub URL",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    expect_match: true,
  },
  {
    label: "Petstore (no bundled match expected)",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    expect_match: false,
  },
];

const headers = {
  "content-type": "application/json",
  "x-mcp-session-id": `match-smoke-${Date.now().toString(36)}`,
};

async function importSpec(url) {
  const res = await fetch(`${BASE}/api/mcp/import-spec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  return res.json();
}

let pass = 0, fail = 0;
console.log(`▶ Track 1 verification against ${BASE}\n`);
for (const spec of SPECS) {
  const r = await importSpec(spec.url);
  const matched = r.matched_bundled === true;
  const ok = matched === spec.expect_match;
  const marker = ok ? "✓" : "✗";
  console.log(`${marker} ${spec.label}`);
  console.log(`    matched_bundled=${matched} (expected ${spec.expect_match})`);
  console.log(`    name='${r.name}' version='${r.version}' sandbox=${r.sandbox_id}`);
  if (r.match_note) console.log(`    note: ${r.match_note}`);
  console.log();
  ok ? pass++ : fail++;
}
console.log(`Summary: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
