// The twin has to survive BETWEEN tool calls, or prove_fix's declared tier
// never gets one.
//
// quickrun/run_workflow resolve a provider twin and return its sandbox_id.
// Nothing carried it forward, so every prove_fix arrived with no twin and the
// declared tier -- the reviewed invariant_check from brain.yaml -- declined.
// Measured on prod 2026-09-08: 11 of 12 runs declined for "no twin supplied",
// and that tier is 0-for-7 all time.
//
// The MCP server is a long-lived stdio process, so module state is exactly one
// IDE session. These tests pin that lifetime and the "additive, never
// subtractive" property the whole change rests on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rememberTwin, lastTwin, __resetTwin } from "../dist/twin.js";

test("a twin recorded by one tool is visible to the next", () => {
  __resetTwin();
  assert.equal(lastTwin(), undefined, "a fresh session starts with no twin");
  rememberTwin("sbx_paddle_1");
  assert.equal(lastTwin(), "sbx_paddle_1");
});

test("the most recent run wins", () => {
  __resetTwin();
  rememberTwin("sbx_first");
  rememberTwin("sbx_second");
  assert.equal(lastTwin(), "sbx_second");
});

test("junk never displaces a real twin", () => {
  // A backend response without sandbox_id must not erase what we hold --
  // otherwise one workflow that returns no twin silently disables the tier for
  // the rest of the session.
  __resetTwin();
  rememberTwin("sbx_real");
  for (const junk of [undefined, null, "", "   "]) rememberTwin(junk);
  assert.equal(lastTwin(), "sbx_real");
});

test("ids are trimmed, since they are sent as-is on the wire", () => {
  __resetTwin();
  rememberTwin("  sbx_padded  ");
  assert.equal(lastTwin(), "sbx_padded");
});

test("nothing is persisted across sessions", async () => {
  // A twin belongs to one IDE session. Persisting it to disk would hand a stale
  // sandbox id to tomorrow's run, which is worse than having none.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/twin.ts", import.meta.url), "utf8"));
  assert.ok(!/writeFileSync|readFileSync|homedir/.test(src),
    "twin.ts must not touch disk");
});
