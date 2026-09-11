// The AGENT-FACING response must carry next_actions. Not the producer.
//
// Measured 2026-09-09, five personas: next_actions absent from every find_bugs
// result the agent received, quickrun called zero times. The routing existed at
// EVERY layer except the one the agent reads:
//
//   phalanx -> backend _work()  sets it        (a test asserts this)
//           -> /jobs projection forwards it    (a test asserts this, and its
//                                               comment says "THE THIRD WHITELIST")
//           -> the MCP client   DROPPED IT     (nothing tested this)
//
// Someone traced three hops and fixed them. The fourth return silently undid the
// lot, while this tool's own description promised "the response carries
// next_actions telling you exactly what".
//
// The declared return type IS the whitelist: a field not named there is dropped
// by omission, and TypeScript reports the ADDITION as the error rather than the
// loss. So this test reads the built output, which is what actually ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const built = readFileSync(new URL("../dist/tools/find_bugs.js", import.meta.url), "utf8");
const src = readFileSync(new URL("../src/tools/find_bugs.ts", import.meta.url), "utf8");

test("the built client forwards next_actions to the agent", () => {
  assert.match(built, /next_actions/,
    "find_bugs' response drops next_actions — the agent gets findings and no path");
});

test("it forwards prove_instructions too", () => {
  assert.match(built, /prove_instructions/);
});

test("the return type names them, or they are dropped by omission", () => {
  const i = src.indexOf("export async function runFindBugs");
  const sig = src.slice(i, i + 400);
  assert.match(sig, /next_actions/, "the declared return type is the whitelist");
  assert.match(sig, /prove_instructions/);
});

test("the description does not promise something the code discards", () => {
  if (/carries `next_actions`/.test(src)) {
    assert.match(built, /next_actions/,
      "the tool description advertises next_actions; the code must return them");
  }
});
