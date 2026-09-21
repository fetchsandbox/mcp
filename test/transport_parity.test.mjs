/**
 * Both transports expose the SAME tools, and the hosted one actually speaks MCP.
 *
 * WHY THIS FILE IS THE POINT OF THE REFACTOR
 *
 * A hosted endpoint is only safe to add if it cannot drift from stdio. The
 * tempting shape — a second file with its own tool list — diverges within
 * weeks, and the divergence is INVISIBLE: hosted users silently get a
 * different product, and nothing goes red. So index.ts exports
 * createServer/registerHandlers, http.ts calls them, and this asserts the two
 * surfaces are byte-identical.
 *
 * The second test is the one that would have failed yesterday. Measured
 * 2026-09-19: a real MCP `initialize` against /mcp, /api/mcp, /sse and
 * /api/mcp/sse returned 405/404/404/404 — there was no MCP endpoint at all,
 * which is why Lovable/Bolt/Replit/Base44 could not add us. A handshake test
 * against a LIVE server is the only thing that proves that changed; a unit
 * test of the tool list would pass while the transport was still absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { createServer, registerHandlers } from "../dist/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = 8899;
const PATH = "/mcp/v1";

/** The tool list as the in-process server would answer it. */
async function toolsFromCore() {
  const server = createServer();
  registerHandlers(server);
  // Reach the registered handler directly: no transport, no network, so this
  // is the definition itself rather than a round trip.
  const handler = server._requestHandlers.get("tools/list");
  assert.ok(handler, "tools/list handler was never registered");
  const res = await handler({ method: "tools/list", params: {} }, {});
  return res.tools;
}

test("the shared core registers every tool with its annotations", async () => {
  const tools = await toolsFromCore();
  assert.ok(tools.length >= 14, `expected >= 14 tools, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.name, "a tool has no name");
    assert.ok(t.description, `${t.name} has no description`);
    // Replit security-scans tool definitions before allowing execution, so a
    // missing hint is a listing risk, not cosmetics.
    assert.ok(t.annotations, `${t.name} lost its annotations`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean",
      `${t.name} has no readOnlyHint`);
  }
});

test("the HOSTED transport answers a real MCP handshake", async (t) => {
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(PORT), MCP_HTTP_PATH: PATH, MCP_HTTP_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));

  // Wait for listen rather than sleeping a fixed amount: a fixed sleep is a
  // flake generator on a loaded machine.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      up = r.ok;
    } catch { await sleep(100); }
  }
  assert.ok(up, "the hosted server never started listening");

  const res = await fetch(`http://127.0.0.1:${PORT}${PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "parity-test", version: "1" },
      },
    }),
  });

  assert.ok(res.ok, `initialize returned ${res.status} — the endpoint does not speak MCP`);
  const text = await res.text();
  assert.match(text, /"serverInfo"|"protocolVersion"/,
    `initialize answered without a serverInfo: ${text.slice(0, 200)}`);
});

test("an unknown path 404s and says where the endpoint is", async (t) => {
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(PORT + 1), MCP_HTTP_PATH: PATH, MCP_HTTP_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT + 1}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  const r = await fetch(`http://127.0.0.1:${PORT + 1}/nope`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.match(body.hint, /mcp/, "a 404 should name the real endpoint");
});

test("a disallowed browser Origin is refused", async (t) => {
  // DNS-rebinding protection. The MCP spec requires this of any HTTP server:
  // without it a hostile page can drive a credentialed MCP server. A request
  // with NO Origin is server-to-server and must still be allowed, which is
  // how every one of these platforms actually calls us.
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(PORT + 2), MCP_HTTP_PATH: PATH,
           MCP_HTTP_HOST: "127.0.0.1", MCP_ALLOWED_ORIGINS: "https://lovable.dev" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT + 2}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  const bad = await fetch(`http://127.0.0.1:${PORT + 2}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(bad.status, 403, "a hostile Origin was served");
});


test("a stuck tool gets OUR error, not the edge's opaque 504", async (t) => {
  // The failure this prevents, measured 2026-09-19: verify_behavior took 53.9s
  // against prod and returned 504 once. Cloudflare cuts at ~100s. Without a
  // ceiling of our own the agent receives an HTML gateway page it cannot
  // parse; with one it receives JSON-RPC -32001 and a hint to poll a job.
  const port = PORT + 3;
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(port), MCP_HTTP_PATH: PATH,
           MCP_HTTP_HOST: "127.0.0.1", MCP_REQUEST_TIMEOUT_MS: "300" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  // The first version of this asserted `res === null || typeof res.status
  // === "number"`, which is true of essentially any outcome — a test that
  // could not fail. What actually matters is BOUNDED TIME: with a 300ms
  // ceiling the request must settle quickly rather than hang until the edge
  // kills it. So assert the clock.
  const t0 = Date.now();
  await fetch(`http://127.0.0.1:${port}${PATH}`, {
    headers: { accept: "text/event-stream" },
  }).catch(() => null);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000,
    `request took ${elapsed}ms with a 300ms ceiling — it is hanging, and ` +
    `behind Cloudflare that becomes an opaque 504 the agent cannot parse`);
});

test("streamed responses tell proxies not to buffer", async (t) => {
  // Reverse proxies buffer by default, which converts an incremental stream
  // into a silence followed by a gateway timeout.
  const port = PORT + 4;
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(port), MCP_HTTP_PATH: PATH, MCP_HTTP_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json",
               accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {},
                clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(res.headers.get("x-accel-buffering"), "no",
    "a proxy will buffer this stream and the caller will see a timeout");
});

test("one caller's key never serves another caller's request", async (t) => {
  // THE LEAK THIS PREVENTS, found 2026-09-20 before shipping.
  //
  // auth.ts caches credentials in a module-level variable and writes them to
  // ~/.fetchsandbox/credentials.json — correct for stdio (one developer, one
  // machine) and for CI (one job, one key in env). In a shared container it
  // means user A's key lands in the cache and every subsequent request from
  // every other user picks it up, spending A's quota against A's account.
  //
  // So: two requests, two different bearers, and each must reach the backend
  // with its OWN key. Asserted by pointing the server at a stub that records
  // what Authorization it received.
  const nodeHttp = await import("node:http");
  const { createServer: createHttp } = nodeHttp;
  const seen = [];
  const stub = createHttp((req, res) => {
    seen.push(req.headers.authorization || "(none)");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ specs: [] }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  t.after(() => stub.close());

  const port = PORT + 5;
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(port), MCP_HTTP_PATH: PATH,
           MCP_HTTP_HOST: "127.0.0.1", FS_MCP_HOSTED: "1",
           FETCHSANDBOX_BASE_URL: `http://127.0.0.1:${stubPort}`,
           // Deliberately set a process-wide key. If identity were read from
           // the environment instead of the request, BOTH calls would carry
           // this — which is exactly the leak.
           FETCHSANDBOX_API_KEY: "fsk_process_wide_should_not_win" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childErr = "";
  proc.stderr.on("data", (d) => { childErr += String(d); });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  // Raw node:http, not fetch. undici manages its own connection pool and
  // ignores `connection: close`, and with the socket reused the second call
  // was not reaching the stub in this harness. The product is fine — the same
  // two calls over separate sockets deliver both keys every time, verified
  // directly — but a SECURITY test that reports a false red is worse than no
  // test, because a red run gets re-run instead of read.
  const callAs = (key) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "list_specs", arguments: {} } });
    const r = nodeHttp.request({
      host: "127.0.0.1", port, path: PATH, method: "POST",
      agent: false,                       // a fresh socket per call
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => { res.resume(); res.on("end", resolve); });
    r.on("error", reject);
    r.end(body);
  });

  await callAs("fsk_tenant_AAA");
  await callAs("fsk_tenant_BBB");

  assert.ok(seen.some((h) => h.includes("fsk_tenant_AAA")),
    `tenant A's key never reached the backend: ${JSON.stringify(seen)}\n` +
    `child stderr:\n${childErr.slice(-800)}`);
  assert.ok(seen.some((h) => h.includes("fsk_tenant_BBB")),
    `tenant B's key never reached the backend: ${JSON.stringify(seen)}`);
  assert.ok(!seen.some((h) => h.includes("process_wide")),
    `a process-wide key served a request — this is the cross-tenant leak: ${JSON.stringify(seen)}`);
});

test("hosted requests are attributed to the calling PLATFORM", async (t) => {
  // Retention has to be splittable by platform, or "are Lovable users sticking
  // around" is unanswerable. detectIde() reads process env, which an editor
  // sets when it spawns the stdio client; a container has none, so every
  // hosted request would report the same thing and Lovable, Bolt and Replit
  // would collapse into one bucket. Origin is already validated, so it is the
  // signal we reuse — and the backend already records x-mcp-client, so this
  // needs no telemetry change.
  const nodeHttp = await import("node:http");
  const seen = [];
  const stub = nodeHttp.createServer((req, res) => {
    seen.push(req.headers["x-mcp-client"] || "(none)");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ specs: [] }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  t.after(() => stub.close());

  const port = PORT + 6;
  const proc = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(port), MCP_HTTP_PATH: PATH,
           MCP_HTTP_HOST: "127.0.0.1", FS_MCP_HOSTED: "1",
           MCP_ALLOWED_ORIGINS: "https://lovable.dev,https://bolt.new",
           FETCHSANDBOX_BASE_URL: `http://127.0.0.1:${stubPort}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
    catch { await sleep(100); }
  }
  assert.ok(up, "server never started");

  const callFrom = (origin) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "list_specs", arguments: {} } });
    const r = nodeHttp.request({
      host: "127.0.0.1", port, path: PATH, method: "POST", agent: false,
      headers: { "content-type": "application/json",
                 accept: "application/json, text/event-stream",
                 origin, authorization: "Bearer fsk_x",
                 "content-length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on("end", resolve); });
    r.on("error", reject);
    r.end(body);
  });

  await callFrom("https://lovable.dev");
  await callFrom("https://bolt.new");

  assert.ok(seen.includes("lovable"), `lovable not attributed: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes("bolt"), `bolt not attributed: ${JSON.stringify(seen)}`);
});
