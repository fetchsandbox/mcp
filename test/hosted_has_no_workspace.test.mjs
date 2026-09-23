/**
 * The filesystem tools must REFUSE on the hosted transport, not pack the server.
 *
 * Found 2026-09-21 asking what a Lovable user still cannot do. find_bugs,
 * fix_bug and prove_fix pack a directory and default to process.cwd(). On
 * stdio that is the developer's project — the point. On the hosted transport
 * that process is OUR container, so a remote caller would tar /app,
 * FetchSandbox's own source, and receive findings about us.
 *
 * The second failure is the worse one: it SUCCEEDS. It burns a Max seat
 * analysing the wrong codebase and returns a plausible answer. An unavailable
 * tool is a known gap; a tool that quietly answers about something else is a
 * false result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async () => {
  const m = await import("../dist/tools/pack.js");
  return m.resolveWorkspaceDir;
};

test("hosted refuses rather than packing the server's own filesystem", async () => {
  process.env.FS_MCP_HOSTED = "1";
  const resolveWorkspaceDir = await load();
  assert.throws(() => resolveWorkspaceDir(), /hosted connector has no access/i);
  delete process.env.FS_MCP_HOSTED;
});

test("the refusal names what the caller CAN do instead", async () => {
  process.env.FS_MCP_HOSTED = "1";
  const resolveWorkspaceDir = await load();
  let msg = "";
  try { resolveWorkspaceDir(); } catch (e) { msg = String(e.message); }
  // A dead end is what made the /device 401 useless. Say the next step.
  for (const hint of ["quickrun", "set_scenario", "npx fetchsandbox-mcp"]) {
    assert.ok(msg.includes(hint), `refusal should mention ${hint}: ${msg}`);
  }
  delete process.env.FS_MCP_HOSTED;
});

test("stdio is untouched — it still resolves a real directory", async () => {
  delete process.env.FS_MCP_HOSTED;
  const resolveWorkspaceDir = await load();
  const dir = resolveWorkspaceDir();
  assert.ok(typeof dir === "string" && dir.length > 0, "stdio must still resolve cwd");
});
