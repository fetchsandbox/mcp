/**
 * A throttle must never be reported as an outage.
 *
 * Measured 2026-09-13 against production: 39 of 40 concurrent requests from one
 * IP came back 503 with an nginx error page, because `limit_req_status` was
 * never set and 503 is nginx's default. The client then said "the upstream is
 * down. Try again in a minute." — false, and the first thing somebody who
 * installed us thirty seconds earlier would read.
 *
 * Two separate defects, so two separate tests: the WORDS, and the RETRY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

test("429 has its own branch, ahead of the 5xx one", () => {
  const i429 = index.indexOf("status === 429");
  const i5xx = index.indexOf("status === 502");
  assert.ok(i429 > -1, "429 must be handled explicitly");
  assert.ok(i429 < i5xx, "429 must be matched BEFORE the 5xx branch, or it falls through");
});

test("the 429 message does not claim the backend is down", () => {
  const start = index.indexOf("status === 429");
  const body = index.slice(start, index.indexOf("status === 502"));
  for (const lie of ["upstream is down", "service unavailable", "backend returned"]) {
    assert.ok(!body.includes(lie), `429 message must not say "${lie}"`);
  }
  assert.ok(/nothing failed|no work was lost/i.test(body),
    "it must say plainly that nothing failed");
  assert.ok(body.includes("Show this to the user"),
    "a message the agent reads but never relays leaves the person guessing");
});

test("429 is NOT retried", () => {
  const m = client.match(/RETRY_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "RETRY_STATUSES must exist");
  const codes = m[1].split(",").map((s) => Number(s.trim()));
  assert.ok(!codes.includes(429),
    "retrying a rate limit adds load to the thing already refusing you");
  for (const c of [502, 503, 504]) {
    assert.ok(codes.includes(c), `${c} is a genuine transient upstream failure and should retry`);
  }
});
