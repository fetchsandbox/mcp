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
import { withRequestIdentity, isHosted } from "../dist/request_context.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";

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

for (const apiKey of ["", "fsk_test_request"]) {
  test(`an HTTP request scope cannot pack server files without a hosted env flag (${apiKey ? "authenticated" : "anonymous"})`, async (t) => {
    const old = process.env.FS_MCP_HOSTED;
    delete process.env.FS_MCP_HOSTED;
    t.after(() => {
      if (old === undefined) delete process.env.FS_MCP_HOSTED;
      else process.env.FS_MCP_HOSTED = old;
    });
    const resolveWorkspaceDir = await load();
    assert.equal(isHosted(), false, "ordinary stdio stays outside the hosted scope");
    await withRequestIdentity({ apiKey }, async () => {
      await Promise.resolve();
      assert.equal(isHosted(), true, "HTTP transport is identified by its active request scope");
      assert.throws(() => resolveWorkspaceDir(), /hosted connector has no access/i);
      assert.throws(() => resolveWorkspaceDir(process.cwd()), /hosted connector has no access/i);
    });
    assert.equal(isHosted(), false, "hosted mode must not leak outside the completed request");
    assert.ok(resolveWorkspaceDir(), "stdio retains workspace access after the request");
  });
}

function plantedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "fs-hosted-scan-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { stripe: "1.0.0" } }));
  writeFileSync(join(dir, "stripe-handler.js"), "// stripe server-only handler\nconst processed_events = new Set();\n");
  return dir;
}

test("hosted coach and guide do not turn the server checkout into customer evidence", async (t) => {
  const dir = plantedWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: JSON.parse(raw), client: req.headers["x-mcp-client"] });
    // Routing is not under test: only the exact body sent by the real transport.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = { ...process.env, PORT: String(port), MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PATH: "/mcp/v1", FETCHSANDBOX_TELEMETRY: "0",
    FETCHSANDBOX_BASE_URL: `http://127.0.0.1:${upstream.address().port}` };
  // The HTTP request scope must be sufficient, including for anonymous callers.
  delete env.FS_MCP_HOSTED;
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../dist/http.js", import.meta.url))],
    { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  proc.stderr.on("data", (data) => { errors += String(data); });
  t.after(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise((resolve) => { proc.once("exit", resolve); proc.kill("SIGKILL"); });
  });
  let up = false;
  for (let n = 0; n < 60 && !up; n++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.ok(up, `HTTP MCP server did not start: ${errors}`);

  const invoke = (tool, args, apiKey) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: tool, arguments: args } });
    const req = request({ host: "127.0.0.1", port, path: "/mcp/v1", method: "POST", agent: false,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        origin: "https://lovable.dev", "content-length": Buffer.byteLength(body),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });

  for (const tool of ["coach", "guide"]) {
    for (const apiKey of ["", "fsk_customer"]) {
      await t.test(`${tool}: ${apiKey ? "authenticated" : "anonymous"} with no app context`, async () => {
        const response = await invoke(tool, { intent: "Help me test my integration" }, apiKey);
        assert.equal(response.status, 200, response.text);
        const call = calls.at(-1);
        assert.equal(call.path, tool === "coach" ? "/api/mcp/coach" : "/api/mcp/route");
        assert.equal(call.client, "lovable");
        assert.equal(call.body.context, undefined,
          `server-only Stripe manifest and guards contaminated ${tool}: ${JSON.stringify(call.body.context)}`);
      });
    }
    for (const [kind, context] of [
      ["partial", { app_base_url: "https://customer.example" }],
      ["provider", { detected_specs: ["paddle"], dependencies: ["customer-declared-package"],
        code_probe: { paddle: { signature: { present: true, at: "customer-declared" } } } }],
    ]) {
      await t.test(`${tool}: explicit ${kind} declarations survive without augmentation`, async () => {
        const response = await invoke(tool, { intent: "Test the app I described", context }, "fsk_customer");
        assert.equal(response.status, 200, response.text);
        assert.deepEqual(calls.at(-1).body.context, context);
      });
    }
  }
});

test("stdio coach and guide still scan the actual client workspace", async (t) => {
  const dir = plantedWorkspace();
  const cwd = process.cwd();
  const oldHosted = process.env.FS_MCP_HOSTED;
  const fetch = globalThis.fetch;
  t.after(() => {
    process.chdir(cwd);
    if (oldHosted === undefined) delete process.env.FS_MCP_HOSTED;
    else process.env.FS_MCP_HOSTED = oldHosted;
    globalThis.fetch = fetch;
    rmSync(dir, { recursive: true, force: true });
  });
  delete process.env.FS_MCP_HOSTED;
  process.chdir(dir);
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const { runCoach } = await import("../dist/tools/coach.js");
  const { runGuide } = await import("../dist/tools/guide.js");
  for (const run of [runCoach, runGuide]) {
    await run({ intent: "Test my integration" });
    const context = calls.at(-1).context;
    assert.deepEqual(context.detected_specs, ["stripe"]);
    assert.equal(context.code_probe.stripe.idempotency.present, true);
    assert.equal(context.code_probe.stripe.idempotency.at, "stripe-handler.js:2");
  }
  assert.deepEqual(calls[0].context.dependencies, ["stripe"]);
});
