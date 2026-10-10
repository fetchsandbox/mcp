import { test } from "node:test";
import assert from "node:assert/strict";
import { postJson, postJsonLong, ToolError } from "../dist/client.js";
import { clearCredentials } from "../dist/auth.js";
import { withRequestIdentity } from "../dist/request_context.js";
import { withSignIn } from "../dist/signin.js";

const backendPath = "/api/mcp/validate_integration";
const request = { session_id: "vs_anonymous", application_context: { goal: "Verify saved workflow" } };

function captureFetch(t, response) {
  const previous = globalThis.fetch;
  const previousTelemetry = process.env.FETCHSANDBOX_TELEMETRY;
  process.env.FETCHSANDBOX_TELEMETRY = "0";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname, authorization: init.headers.authorization });
    return response();
  };
  t.after(() => {
    globalThis.fetch = previous;
    if (previousTelemetry === undefined) delete process.env.FETCHSANDBOX_TELEMETRY;
    else process.env.FETCHSANDBOX_TELEMETRY = previousTelemetry;
  });
  return calls;
}

for (const apiKey of ["", "fsk_test_not_a_real_secret"]) {
  test(`hosted 401 distinguishes ${apiKey ? "forwarded" : "missing"} Bearer without exposing credentials or starting device flow`, async (t) => {
    const upstreamSecret = "private-upstream-header-value";
    const calls = captureFetch(t, () => new Response(JSON.stringify({ detail: upstreamSecret }), {
      status: 401, headers: { "content-type": "application/json" },
    }));
    const output = [];
    const captureWrite = (chunk, encoding, callback) => {
      output.push(String(chunk));
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    };
    const stdout = t.mock.method(process.stdout, "write", captureWrite);
    const stderr = t.mock.method(process.stderr, "write", captureWrite);
    let thrown;
    try {
      await withRequestIdentity({ apiKey }, async () => {
        try { await withSignIn(() => postJson(backendPath, request)); }
        catch (error) { thrown = error; }
      });
    } finally {
      stdout.mock.restore();
      stderr.mock.restore();
    }
    assert.ok(output.length === 0, "authentication diagnostics must not print to stdout or stderr");
    assert.ok(thrown instanceof ToolError);
    assert.equal(thrown.status, 401);
    assert.equal(calls.length, 1, "no retry or device-flow request is allowed");
    assert.equal(calls[0].path, backendPath);
    assert.ok(calls[0].authorization === (apiKey ? `Bearer ${apiKey}` : undefined),
      "the request context must control upstream authentication");
    if (apiKey) {
      assert.match(thrown.message, /Bearer token reached.*was forwarded.*backend denied/);
      assert.match(thrown.message, /does not identify the cause/);
      assert.doesNotMatch(thrown.message, /No usable Bearer|key is invalid|key was rejected/i);
      assert.ok(!thrown.message.includes(apiKey), "credential must not appear in the diagnostic");
    } else {
      assert.match(thrown.message, /No usable Bearer token reached/);
      assert.doesNotMatch(thrown.message, /was forwarded/);
    }
    assert.ok(!thrown.message.includes(upstreamSecret), "raw backend errors must not be echoed");
    assert.match(thrown.message, /Authorization: Bearer <FetchSandbox account API key>/);
    assert.match(thrown.message, /FETCHSANDBOX_API_KEY is a local process environment variable/);
    assert.match(thrown.message, /start a fresh owned validate_integration session/);
    assert.match(thrown.message, /if your session was created anonymously/);
    assert.match(thrown.message, /anonymous session cannot be upgraded/);
    assert.match(thrown.message, /retry the same owned session and run/);
    assert.match(thrown.message, /do not create a replacement attempt/);
    assert.doesNotMatch(thrown.message, /fetchsandbox\.com\/device/);
  });
}

test("hosted success passes through unchanged without a sign-in request", async (t) => {
  const expected = { session_id: "vs_owned", app_verified: false };
  const calls = captureFetch(t, () => new Response(JSON.stringify(expected), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  const result = await withRequestIdentity({ apiKey: "fsk_success_fixture" },
    () => withSignIn(() => postJson(backendPath, request)));
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
});

test("hosted non-401 errors preserve status and identity instead of suggesting authentication", async (t) => {
  const calls = captureFetch(t, () => { throw new Error("device flow must not run"); });
  const denied = new ToolError("Start a fresh owned session for application verification", 403);
  await assert.rejects(withRequestIdentity({ apiKey: "fsk_owner_fixture" },
    () => withSignIn(async () => { throw denied; })), error => error === denied);
  assert.equal(calls.length, 0);
});

test("hosted deployment flag without request context does not invent forwarding evidence", async (t) => {
  const previous = process.env.FS_MCP_HOSTED;
  process.env.FS_MCP_HOSTED = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.FS_MCP_HOSTED;
    else process.env.FS_MCP_HOSTED = previous;
  });
  const calls = captureFetch(t, () => { throw new Error("device flow must not run"); });
  await assert.rejects(withSignIn(async () => { throw new ToolError("private-backend-error", 401); }), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /could not authenticate this hosted operation/);
    assert.doesNotMatch(error.message, /No usable Bearer|was forwarded|private-backend-error/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("stdio still starts its existing device flow after a first 401", async (t) => {
  const previous = process.env.FS_MCP_HOSTED;
  delete process.env.FS_MCP_HOSTED;
  clearCredentials(); // Prevent reading any real local credentials during this test.
  t.after(() => {
    if (previous === undefined) delete process.env.FS_MCP_HOSTED;
    else process.env.FS_MCP_HOSTED = previous;
    clearCredentials();
  });
  const calls = captureFetch(t, () => new Response(JSON.stringify({
    device_code: "test-only-device-code", user_code: "TEST-CODE",
    verification_uri: "https://fetchsandbox.com/device", expires_in: 600, interval: 5,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(withSignIn(async () => { throw new ToolError("Sign in", 401); }), error => {
    assert.match(error.message, /fetchsandbox\.com\/device\?code=TEST-CODE/);
    assert.doesNotMatch(error.message, /hosted connector|Bearer token reached/);
    return true;
  });
  assert.deepEqual(calls.map(call => call.path), ["/api/auth/device/code"]);
});

const reasons = {
  missing_authorization: /backend received no Authorization header/,
  malformed_authorization: /Authorization header without a usable Bearer token/,
  unsupported_bearer: /not in FetchSandbox account API key format/,
  account_key_unrecognized: /may be unknown, revoked, or no longer linked to an account/,
  identity_lookup_failed: /server-side identity lookup failure/,
};

for (const [reason, description] of Object.entries(reasons)) {
  for (const [name, send] of [["regular", postJson], ["long-running", postJsonLong]]) {
    test(`${name} hosted call preserves bounded backend reason ${reason}`, async (t) => {
      const secret = "fsk_private_diagnostic_fixture";
      const rawError = "private-backend-exception";
      const calls = captureFetch(t, () => new Response(JSON.stringify({ detail: rawError }), {
        status: 401,
        headers: { "content-type": "application/json", "X-FetchSandbox-Auth-Reason": reason },
      }));
      await assert.rejects(withRequestIdentity({ apiKey: secret },
        () => withSignIn(() => send(backendPath, request))), error => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.status, 401);
        assert.equal(error.authReason, reason);
        assert.match(error.message, description);
        assert.ok(error.message.includes(`Authentication diagnostic: ${reason} (HTTP 401)`));
        assert.ok(!error.message.includes(secret), "credential must not appear in guidance");
        assert.ok(!error.message.includes(rawError), "raw error must not appear in guidance");
        assert.doesNotMatch(error.message, /key is invalid|key was rejected/i);
        if (reason === "identity_lookup_failed") {
          assert.match(error.message, /Keep the current connector authentication/);
          assert.doesNotMatch(error.message, /Configure this hosted connector/);
        } else {
          assert.match(error.message, /Authorization: Bearer <FetchSandbox account API key>/);
        }
        return true;
      });
      assert.equal(calls.length, 1, "no automatic retry or device flow after backend 401");
    });
  }
}

test("unknown backend reason is discarded and hosted guidance keeps its bounded fallback", async (t) => {
  const untrustedReason = "private-header-value-not-a-reason";
  captureFetch(t, () => new Response("private-backend-body", {
    status: 401, headers: { "X-FetchSandbox-Auth-Reason": untrustedReason },
  }));
  await assert.rejects(withRequestIdentity({ apiKey: "fsk_test_only" },
    () => withSignIn(() => postJson(backendPath, request))), error => {
    assert.equal(error.authReason, undefined);
    assert.match(error.message, /Bearer token reached.*was forwarded.*backend denied/);
    assert.ok(!error.message.includes(untrustedReason));
    assert.doesNotMatch(error.message, /private-backend-body|Authentication diagnostic:/);
    return true;
  });
});

test("a non-401 response cannot acquire an account authentication reason", async (t) => {
  captureFetch(t, () => new Response(JSON.stringify({ detail: "Owned session required" }), {
    status: 403, headers: { "X-FetchSandbox-Auth-Reason": "account_key_unrecognized" },
  }));
  await assert.rejects(withRequestIdentity({ apiKey: "fsk_test_only" },
    () => withSignIn(() => postJson(backendPath, request))), error => {
    assert.equal(error.status, 403);
    assert.equal(error.message, "Owned session required");
    assert.equal(error.authReason, undefined);
    return true;
  });
});

for (const state of ["absent", "malformed", "bearer_present"]) {
  test(`hosted ingress ${state} stays distinct from backend missing_authorization`, async (t) => {
    const secret = "fsk_ingress_fixture_never_print";
    captureFetch(t, () => new Response("private-backend-error", {
      status: 401, headers: { "X-FetchSandbox-Auth-Reason": "missing_authorization" },
    }));
    await assert.rejects(withRequestIdentity({
      apiKey: state === "bearer_present" ? secret : "",
      authHeaderState: state, requestId: "cafe1234",
    }, () => withSignIn(() => postJson(backendPath, request))), error => {
      assert.equal(error.authReason, "missing_authorization", "do not rewrite backend evidence");
      assert.match(error.message, /backend received no Authorization header/);
      assert.ok(error.message.includes(`Hosted MCP authentication input: ${state}.`));
      assert.match(error.message, /MCP request ID: cafe1234/);
      if (state === "malformed") assert.match(error.message, /header reached.*not a usable Bearer header; no credential was forwarded/);
      if (state === "absent") assert.match(error.message, /every protected tool request, not only initialization/);
      if (state === "bearer_present") assert.match(error.message, /usable Bearer header reached the hosted MCP endpoint/);
      assert.ok(!error.message.includes(secret));
      assert.doesNotMatch(error.message, /private-backend-error|key is invalid|key was rejected/);
      return true;
    });
  });
}

test("hosted correlation never echoes an untrusted request identifier", async (t) => {
  const secret = "fsk_do_not_echo_request_id";
  captureFetch(t, () => new Response("", { status: 401 }));
  await assert.rejects(withRequestIdentity({ apiKey: "", requestId: secret },
    () => withSignIn(() => postJson(backendPath, request))), error => {
      assert.ok(!error.message.includes(secret));
      assert.doesNotMatch(error.message, /MCP request ID:/);
      return true;
    });
});
