/**
 * Per-request identity, for the HOSTED transport only.
 *
 * THE BUG THIS EXISTS TO PREVENT, found 2026-09-20 before shipping.
 *
 * `auth.ts` caches credentials in a module-level variable and writes them to
 * ~/.fetchsandbox/credentials.json. That is exactly right for stdio, where the
 * process belongs to one developer on their own machine, and for CI, where the
 * job is one tenant with one key in the environment.
 *
 * It is a cross-tenant credential leak in a shared container. User A completes
 * a device flow (or simply calls a tool), their key lands in the module cache
 * and on disk, and every subsequent request FROM EVERY OTHER USER picks it up
 * — spending A's quota, against A's account, attributed to A. One server, many
 * agents, and no isolation at all.
 *
 * THE SHAPE OF THE FIX
 *
 * There is exactly one place credentials are read for an outbound call:
 * `buildHeaders()` in client.ts. So identity becomes request-scoped at that
 * single chokepoint, resolved in priority order:
 *
 *     request context  ->  FETCHSANDBOX_API_KEY  ->  ~/.fetchsandbox
 *      (hosted)              (CI/CD)                  (a developer's machine)
 *
 * Each deployment shape keeps the source that is correct for it, and stdio and
 * CI are byte-identical to before because neither ever enters a request scope.
 *
 * WHY AsyncLocalStorage AND NOT A PARAMETER
 *
 * Threading a credential through all 16 tools and every call site is more
 * explicit, and it is the shape that drifts: a seventeenth tool forgets the
 * argument and nothing goes red. One chokepoint cannot be forgotten.
 *
 * The tradeoff is real and worth naming: the context is implicit, so a tool
 * that spawns a DETACHED async task loses it. That fails CLOSED — no key, the
 * backend answers 401 — which is the safe direction, but it is a sharp edge.
 *
 * WHY WE DO NOT VALIDATE THE KEY HERE
 *
 * This process forwards; the backend decides. It runs IdentityMiddleware and
 * RequireAuthMiddleware exactly as it does for the stdio client, so a hosted
 * caller and a local caller can never get different answers about who may
 * spend. It is also not the "token passthrough" anti-pattern: these are our
 * own fsk_ keys going to our own backend, not a third party's token forwarded
 * somewhere it was never issued for.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestIdentity {
  /** The bearer the caller presented. Never read from disk, never cached. */
  apiKey: string;
  /** For log correlation. Not sent upstream. */
  requestId?: string;
  /**
   * The calling platform (lovable, bolt, replit, base44, …), from Origin.
   * Sent upstream as x-mcp-client so retention can be split per platform —
   * detectIde() cannot do this in a container, where there is no editor env.
   */
  platform?: string;
}

const storage = new AsyncLocalStorage<RequestIdentity>();

/** Run `fn` with this request's identity bound to the async context. */
export function withRequestIdentity<T>(id: RequestIdentity, fn: () => Promise<T>): Promise<T> {
  return storage.run(id, fn);
}

/**
 * The identity of the in-flight request, or undefined outside one.
 *
 * `undefined` is the normal case for stdio and CI — it is how those keep their
 * existing behaviour rather than a failure.
 */
export function currentIdentity(): RequestIdentity | undefined {
  return storage.getStore();
}

/**
 * True when this process is the hosted transport.
 *
 * Gates the device flow. `withSignIn` calls writeCredentials on success, and
 * on a shared server that write IS the leak — one user's browser sign-in
 * would become every user's credential. A hosted caller presents a key the
 * platform already holds; it never completes a browser flow on our box.
 */
export function isHosted(): boolean {
  return process.env.FS_MCP_HOSTED === "1";
}
