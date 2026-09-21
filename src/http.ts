/**
 * The HOSTED entry point. Same tools, same handlers, over streamable HTTP.
 *
 * WHY THIS EXISTS
 *
 * Lovable, Bolt, Replit and Base44 all require a remote MCP URL. None of them
 * can spawn a local process, so `npx fetchsandbox-mcp` — the only transport we
 * had — means those users literally cannot add us. Verified 2026-09-19 against
 * each platform's own documentation, and by sending a real MCP `initialize` to
 * /mcp, /api/mcp, /sse and /api/mcp/sse, which answered 405/404/404/404.
 *
 * All four accept a static bearer or header instead of OAuth, so this one
 * build serves all four and OAuth stays a later, directory-specific concern.
 *
 * WHAT IT IS NOT
 *
 * Not a second implementation. It imports `createServer` and
 * `registerHandlers` from index.ts, so the 14 tool definitions, their
 * annotations and their dispatch are the SAME objects stdio uses. A
 * hand-written tool list here would drift within weeks and the drift would be
 * invisible — hosted users silently getting a different product. The parity
 * test pins it.
 *
 * STATELESS, DELIBERATELY
 *
 * `sessionIdGenerator: undefined`. Every piece of state we have already lives
 * server-side and is addressed by `sandbox_id`, which the tools pass
 * explicitly. There is nothing for a session to hold. Stateless means no
 * session store, no sticky routing, and horizontal scale for free; stateful
 * would add a failure mode for state we do not have.
 *
 * AUTH FORWARDS, IT NEVER DECIDES
 *
 * The caller's Authorization header is passed through to the backend, which
 * runs IdentityMiddleware and RequireAuthMiddleware exactly as it does for the
 * stdio client. This process holds no user table and validates no key. One
 * source of truth for auth, so a hosted caller and a local caller can never
 * get different answers about who may spend.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer, registerHandlers } from "./index.js";
import { withRequestIdentity } from "./request_context.js";
import { VERSION } from "./version.js";

const PORT = Number(process.env.PORT || 8787);
const PATH = process.env.MCP_HTTP_PATH || "/mcp/v1";

/**
 * Bind LOOPBACK by default.
 *
 * The MCP security guidance is explicit: an HTTP MCP server running locally
 * binds 127.0.0.1, not 0.0.0.0, or any process on the network can drive it.
 * In a container the orchestrator needs 0.0.0.0, so it is overridable — but
 * the default is the safe one, because the unsafe default is the one people
 * ship by accident.
 */
const HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";

/**
 * Hard ceiling on a single tool call.
 *
 * Measured 2026-09-19: verify_behavior took 53.9s against prod and returned
 * 504 on a first attempt; Cloudflare cuts at ~100s. A request with no ceiling
 * of our own becomes a zombie holding a connection until the edge kills it,
 * and the caller sees an opaque gateway error instead of ours. Ending it
 * ourselves, just inside the edge's limit, means the agent gets a JSON-RPC
 * error it can act on.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 90_000);

/**
 * Origins allowed to drive this endpoint.
 *
 * The MCP spec requires an HTTP server to validate Origin: without it a
 * hostile page in a user's browser can drive a local or credentialed MCP
 * server (DNS rebinding). A request with no Origin at all is a server-to-
 * server call and is allowed — that is how every one of these platforms
 * actually calls us.
 */
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ||
  "https://lovable.dev,https://bolt.new,https://replit.com,https://app.base44.com,https://fetchsandbox.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Which platform is calling.
 *
 * `detectIde()` reads process ENV VARS, which the editor sets when it spawns
 * the stdio client. A container has no such env, so every hosted request
 * would report the same thing and Lovable, Bolt and Replit would land in one
 * undifferentiated bucket — you could not tell which platform retains.
 *
 * Origin is the signal we already validate, so it costs nothing to reuse. The
 * backend records `x-mcp-client` today, so setting it here splits retention by
 * platform with no telemetry change at all.
 */
function callerPlatform(req: IncomingMessage): string {
  const origin = (req.headers.origin || "").toLowerCase();
  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  const hay = origin + " " + ua;
  for (const [needle, name] of [
    ["lovable", "lovable"], ["bolt.new", "bolt"], ["stackblitz", "bolt"],
    ["replit", "replit"], ["base44", "base44"],
    ["claude", "claude"], ["cursor", "cursor"], ["openai", "chatgpt"],
  ] as const) {
    if (hay.includes(needle)) return name;
  }
  // Honest default. "unknown" is a real answer; guessing a platform would
  // put made-up rows in the retention split.
  return "hosted-unknown";
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;               // server-to-server, no browser
  return ALLOWED_ORIGINS.includes(origin);
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** A JSON-RPC error, which is what an MCP client can actually parse. */
function rpcError(res: ServerResponse, status: number, code: number,
                  message: string, data?: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null,
                           error: { code, message, ...(data ? { data } : {}) } }));
}

/**
 * A FRESH server + transport per request. This is what stateless actually means.
 *
 * The first version connected one server to one transport at startup and
 * reused both. `initialize` worked; the very next `tools/call` returned 500 in
 * 0ms — the transport had already been consumed by the previous exchange and
 * rejected the new one before any tool ran. A shared transport is a single
 * request/response pair, not a server.
 *
 * Per-request construction is cheap (the tool definitions are module-level
 * objects; only the wiring is rebuilt) and it is what makes round-robin load
 * balancing correct: no instance holds anything another instance would need.
 */
/** The caller's bearer, or "" — never a cached or on-disk key. */
function bearerOf(req: IncomingMessage): string {
  const h = req.headers.authorization || "";
  const [scheme, ...rest] = h.split(" ");
  return scheme?.toLowerCase() === "bearer" ? rest.join(" ").trim() : "";
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, reqId: string) {
  const server = createServer();
  registerHandlers(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless: no session ids, no affinity
  });
  // Close both when the response ends, or every request leaks a server.
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  // EVERY tool call for this request runs inside this identity. buildHeaders()
  // reads it at the single chokepoint, so no tool can accidentally reach for a
  // shared credential. Absent bearer => no key => the backend answers 401,
  // which is the correct, fail-closed outcome for a hosted caller.
  await withRequestIdentity(
    { apiKey: bearerOf(req), requestId: reqId, platform: callerPlatform(req) },
    () => transport.handleRequest(req, res),
  );
}

async function main() {
  const http = createHttpServer(async (req, res) => {
    const started = Date.now();
    const reqId = randomUUID().slice(0, 8);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // ONE LINE PER REQUEST, to stderr.
    //
    // A hosted endpoint whose failures are invisible is one nobody can trust.
    // This repo already records the cost of that: mcp telemetry had no way to
    // reach a user for months, so "who is failing" was unanswerable while both
    // halves of the data existed. Structured, greppable, no PII — method, path,
    // status, duration.
    const done = (status: number, note = "") => {
      process.stderr.write(
        `[mcp-http] id=${reqId} ${req.method} ${url.pathname} ` +
        `status=${status} ms=${Date.now() - started} ` +
        `client=${callerPlatform(req)}${note ? " " + note : ""}\n`,
      );
    };
    res.on("finish", () => done(res.statusCode));

    // Liveness, deliberately OUTSIDE the MCP path so a health checker never
    // has to speak the protocol.
    if (url.pathname === "/healthz") {
      // Outside the MCP path on purpose: a readiness probe must never have to
      // speak the protocol, and a load balancer must be able to check liveness
      // without a valid session or key.
      return json(res, 200, { ok: true, version: VERSION, path: PATH });
    }

    if (url.pathname !== PATH) {
      return json(res, 404, {
        error: "not found",
        hint: `the MCP endpoint is ${PATH}`,
      });
    }

    // Reverse proxies buffer by default, which holds a streamed response until
    // it completes — turning an incremental stream into a long silence and
    // then a gateway timeout. Cloudflare sits in front of this and cuts at
    // ~100s, which is how verify_behavior produced a 504 at 54s. Telling the
    // proxy not to buffer is the half we control from here; the nginx side
    // needs proxy_buffering off.
    res.setHeader("X-Accel-Buffering", "no");

    if (!originAllowed(req)) {
      // Refuse rather than silently serve: a rejected origin is a security
      // event, and a 403 that says why is easier to debug than a hang.
      return json(res, 403, {
        error: "origin not allowed",
        origin: req.headers.origin,
      });
    }

    // A ceiling of our own, just inside the edge's. Without it a stuck tool
    // holds the connection until Cloudflare kills it and the agent gets an
    // opaque 504 instead of an error it can reason about.
    const killer = setTimeout(() => {
      if (!res.headersSent) {
        rpcError(res, 504, -32001,
                 `tool call exceeded ${REQUEST_TIMEOUT_MS}ms`,
                 { request_id: reqId, hint: "long tools return a job_id; poll it instead" });
        done(504, "timeout");
      } else {
        res.destroy();
      }
    }, REQUEST_TIMEOUT_MS);
    killer.unref?.();

    try {
      await handleMcp(req, res, reqId);
    } catch (err) {
      // Never leak a stack to a caller; log it where an operator can see it.
      const id = randomUUID().slice(0, 8);
      process.stderr.write(`[fetchsandbox-mcp-http] ${id} ${String(err)}\n`);
      if (!res.headersSent) {
        rpcError(res, 500, -32603, "internal error", { request_id: id });
      }
    } finally {
      clearTimeout(killer);
    }
  });

  // Zombie connections are the other way a hosted server degrades quietly:
  // sockets accumulate, the process looks healthy, and new requests queue.
  http.headersTimeout = REQUEST_TIMEOUT_MS + 10_000;
  http.requestTimeout = REQUEST_TIMEOUT_MS + 10_000;
  http.keepAliveTimeout = 65_000;   // above a typical 60s LB idle timeout

  http.listen(PORT, HOST, () => {
    process.stderr.write(
      `[fetchsandbox-mcp-http ${VERSION}] listening on ${HOST}:${PORT}${PATH} ` +
      `(stateless; timeout ${REQUEST_TIMEOUT_MS}ms; origins ${ALLOWED_ORIGINS.length})\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`[fetchsandbox-mcp-http] fatal: ${String(err)}\n`);
  process.exit(1);
});
