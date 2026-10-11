/** Exercise the real HTTP ingress, MCP dispatcher and backend client together. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const MCP_PATH = "/mcp/v1";
const BACKEND_PATH = "/api/mcp/validate_integration";
// Fixtures only. Never inherit a developer's credentials, home or backend URL.
const KEY_A = "fsk_fake_tenant_a_ingress_fixture";
const KEY_B = "fsk_fake_tenant_b_ingress_fixture";
const ENV_KEY = "fsk_fake_process_env_must_not_be_used";
const WRONG_HEADER_KEY = "fsk_fake_wrong_header_must_not_be_used";
const BASIC_AUTH = "Basic dGVzdDpmaXh0dXJl";
const PRIVATE_ERROR = "private-backend-error-fixture";
const sensitiveFixtures = [KEY_A, KEY_B, ENV_KEY, WRONG_HEADER_KEY, BASIC_AUTH, PRIVATE_ERROR];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function exchange(port, agent, message, headers = {}) {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: MCP_PATH, method: "POST", agent,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const payload = res.headers["content-type"]?.includes("text/event-stream")
            ? text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)))
              .find((row) => row.id === message.id)
            : JSON.parse(text);
          resolve({ status: res.statusCode, headers: res.headers, payload, text,
            reusedSocket: req.reusedSocket });
        } catch { reject(new Error("MCP returned an unreadable response")); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("local MCP request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

test("real hosted HTTP isolates protected application-context authentication", { timeout: 30000 }, async (t) => {
  const seen = [];
  let active = 0;
  let peakActive = 0;
  const backend = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const authorization = req.headers.authorization;
    seen.push({ path: req.url, method: req.method, body, authorization });
    active += 1;
    peakActive = Math.max(peakActive, active);
    // Keep several requests in flight at once to exercise AsyncLocalStorage.
    await sleep(body.session_id?.includes("concurrent") ? 50 : 1);
    active -= 1;
    const owner = authorization === `Bearer ${KEY_A}` ? "tenant_a"
      : authorization === `Bearer ${KEY_B}` ? "tenant_b" : null;
    if (!owner) {
      res.writeHead(401, {
        "content-type": "application/json",
        "x-fetchsandbox-auth-reason": authorization
          ? "account_key_unrecognized" : "missing_authorization",
      });
      // Prove the hosted wrapper does not echo a raw backend exception/key.
      res.end(JSON.stringify({ detail: `${PRIVATE_ERROR} ${KEY_A} ${KEY_B}` }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ session_id: body.session_id, owner,
        application_context: body.application_context, app_verified: false }));
    }
  });
  const backendPort = await listen(backend);
  t.after(() => { backend.closeAllConnections(); backend.close(); });

  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const isolatedHome = await mkdtemp(join(tmpdir(), "mcp-auth-ingress-"));
  t.after(() => rm(isolatedHome, { recursive: true, force: true }));
  const proc = spawn(process.execPath, ["dist/http.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH || "", HOME: isolatedHome,
      PORT: String(port), MCP_HTTP_PATH: MCP_PATH, MCP_HTTP_HOST: "127.0.0.1",
      FETCHSANDBOX_BASE_URL: `http://127.0.0.1:${backendPort}`,
      FETCHSANDBOX_API_KEY: ENV_KEY, FETCHSANDBOX_TELEMETRY: "0",
      // Omit FS_MCP_HOSTED: the HTTP request itself must establish hosted scope.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => proc.kill("SIGKILL"));
  for (let tries = 0; !output.includes("listening on") && tries < 100; tries++) {
    await sleep(25);
  }
  assert.ok(output.includes("listening on"), "local MCP child did not start");

  const sequential = new Agent({ keepAlive: true, maxSockets: 1 });
  const concurrent = new Agent({ keepAlive: true, maxSockets: 8 });
  t.after(() => { sequential.destroy(); concurrent.destroy(); });
  const responses = [];
  let id = 0;
  const call = async (label, headers, owner, authState, agent = sequential) => {
    const session = `vs_${label}`;
    const context = { goal: `Inspect fixture ${label}`, app_version: "test-only" };
    const response = await exchange(port, agent, {
      jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name: "validate_integration",
        arguments: { session_id: session, application_context: context } },
    }, headers);
    responses.push({ ...response, authState });
    assert.equal(response.status, 200, `${label}: expected MCP response`);
    assert.ok(response.payload?.result, `${label}: missing tool result`);
    const result = response.payload.result;
    const text = result.content.map((item) => item.text || "").join("\n");
    if (owner) {
      assert.notEqual(result.isError, true, `${label}: authenticated call failed`);
      const returned = JSON.parse(text);
      assert.equal(returned.owner, owner, `${label}: wrong tenant returned`);
      assert.equal(returned.session_id, session, `${label}: wrong session returned`);
      assert.deepEqual(returned.application_context, context);
    } else {
      assert.equal(result.isError, true, `${label}: anonymous call gained access`);
      assert.ok(/Authentication diagnostic: missing_authorization \(HTTP 401\)/.test(text),
        `${label}: missing the bounded backend authentication reason`);
      if (authState === "malformed") {
        assert.ok(text.includes("Hosted MCP authentication input: malformed"),
          `${label}: malformed ingress must be distinguished from absent ingress`);
      } else {
        assert.ok(!text.includes("Hosted MCP authentication input: malformed"),
          `${label}: absent ingress must not be labeled malformed`);
      }
    }
    const matching = seen.filter((row) => row.body.session_id === session);
    assert.equal(matching.length, 1, `${label}: expected one protected backend call`);
    assert.equal(matching[0].path, BACKEND_PATH);
    assert.equal(matching[0].method, "POST");
    assert.deepEqual(matching[0].body.application_context, context);
    // Keep actual authorization private even on assertion failure.
    const expected = owner === "tenant_a" ? `Bearer ${KEY_A}`
      : owner === "tenant_b" ? `Bearer ${KEY_B}` : undefined;
    assert.ok(matching[0].authorization === expected,
      `${label}: backend authorization differed from this request's fixture`);
    return response;
  };

  const matrix = [
    ["missing_header", {}, null, "absent"],
    ["wrong_environment_header", { FETCHSANDBOX_API_KEY: WRONG_HEADER_KEY }, null, "absent"],
    ["bare_authorization", { Authorization: KEY_A }, null, "malformed"],
    ["basic_authorization", { Authorization: BASIC_AUTH }, null, "malformed"],
    ["empty_bearer", { Authorization: "Bearer " }, null, "malformed"],
    ["bogus_mcp_session", { "Mcp-Session-Id": "fixture-session-not-authentication" }, null, "absent"],
    ["valid_bearer", { Authorization: `Bearer ${KEY_A}` }, "tenant_a", "bearer_present"],
    ["lowercase_header_and_scheme", { authorization: `bearer ${KEY_B}` }, "tenant_b", "bearer_present"],
  ];
  for (const [label, headers, owner, authState] of matrix) {
    await t.test(label, () => call(label, headers, owner, authState));
  }

  await t.test("initialize credentials do not authenticate the next request", async () => {
    const initialized = await exchange(port, sequential, {
      jsonrpc: "2.0", id: ++id, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "auth-ingress-fixture", version: "1" },
      },
    }, { Authorization: `Bearer ${KEY_A}` });
    assert.equal(initialized.status, 200);
    assert.ok(initialized.payload?.result?.serverInfo);
    responses.push({ ...initialized, authState: "bearer_present" });
    const listed = await exchange(port, sequential, {
      jsonrpc: "2.0", id: ++id, method: "tools/list", params: {},
    });
    assert.equal(listed.status, 200);
    assert.ok(listed.payload?.result?.tools.some((tool) => tool.name === "validate_integration"));
    assert.equal(listed.reusedSocket, true, "tools/list must reuse the handshake socket");
    responses.push({ ...listed, authState: "absent" });
    const anonymous = await call("after_authenticated_initialize", {}, null, "absent");
    assert.equal(anonymous.reusedSocket, true, "must test the same keep-alive socket");
  });

  await t.test("interleaved tenants and anonymous calls share a socket without sharing identity", async () => {
    for (const [label, key, owner] of [
      ["interleaved_a", KEY_A, "tenant_a"],
      ["interleaved_none", null, null],
      ["interleaved_b", KEY_B, "tenant_b"],
      ["interleaved_none_again", null, null],
      ["interleaved_a_again", KEY_A, "tenant_a"],
    ]) {
      const response = await call(label, key ? { Authorization: `Bearer ${key}` } : {},
        owner, key ? "bearer_present" : "absent");
      assert.equal(response.reusedSocket, true, "must reuse the keep-alive socket");
    }
  });

  await t.test("overlapping tenant calls do not leak identity or use process credentials", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const owner = index % 3 === 0 ? "tenant_a" : index % 3 === 1 ? "tenant_b" : null;
      const key = owner === "tenant_a" ? KEY_A : owner === "tenant_b" ? KEY_B : null;
      return call(`concurrent_${index}`, key ? { Authorization: `Bearer ${key}` } : {},
        owner, key ? "bearer_present" : "absent", concurrent);
    }));
    assert.ok(peakActive >= 2, "backend requests must actually overlap");
    await call("after_concurrent_anonymous", {}, null, "absent");
  });

  await t.test("diagnostics contain only bounded auth state and request correlation", async () => {
    // The child's stderr pipe can arrive just after the HTTP response completes.
    for (let tries = 0; tries < 40; tries++) {
      if (responses.every((row) => output.includes(`id=${row.headers["x-fetchsandbox-mcp-request-id"]} `))) break;
      await sleep(25);
    }
    const ids = new Set();
    for (const response of responses) {
      const requestId = response.headers["x-fetchsandbox-mcp-request-id"];
      assert.match(requestId || "", /^[a-f0-9]{8}$/, "response must expose a bounded request id");
      assert.ok(!ids.has(requestId), "each HTTP request needs a distinct correlation id");
      ids.add(requestId);
      const line = output.split("\n").find((row) => row.includes(`id=${requestId} `));
      assert.ok(line, "request id must correlate with a server log line");
      assert.ok(new RegExp(`(?:^| )auth_header=${response.authState}(?: |$)`).test(line),
        "log must reflect this request's bounded authentication input state");
      for (const fixture of sensitiveFixtures) {
        assert.ok(!response.text.includes(fixture), "response exposed a private fixture value");
      }
    }
    for (const fixture of sensitiveFixtures) {
      assert.ok(!output.includes(fixture), "server logs exposed a private fixture value");
    }
    assert.ok(seen.every((row) => row.path === BACKEND_PATH),
      "hosted auth failure must not invoke device sign-in or another backend operation");
    assert.ok(seen.every((row) => row.authorization !== `Bearer ${ENV_KEY}`),
      "a hosted request must never fall back to the process API key");
  });
});
