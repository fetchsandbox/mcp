/**
 * Thin HTTP client for the FetchSandbox backend.
 *
 * Base URL defaults to https://fetchsandbox.com. Override via
 * FETCHSANDBOX_BASE_URL for stage testing or self-hosted deployments.
 *
 * Errors are normalized into ToolError so tools can surface them to the
 * agent as readable text instead of a stack trace.
 */
import { getSessionId } from "./session.js";

const DEFAULT_BASE_URL = "https://fetchsandbox.com";
const REQUEST_TIMEOUT_MS = 30_000;

// Retry only on transient failures: nginx 502/503/504 + network errors.
// 4xx responses (bad spec, validation errors) should fail fast.
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 1500;

export class ToolError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ToolError";
    this.status = status;
  }
}

export function getBaseUrl(): string {
  return (process.env.FETCHSANDBOX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": `fetchsandbox-mcp/0.1.0 (node ${process.version})`,
    accept: "application/json",
    ...(extra ?? {}),
  };
  const sid = getSessionId();
  if (sid) headers["x-mcp-session-id"] = sid;
  return headers;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.text();
    if (!body) return `HTTP ${res.status}`;
    try {
      const j = JSON.parse(body);
      if (typeof j === "object" && j !== null && "detail" in j) return String(j.detail);
    } catch {
      // not JSON
    }
    return body.slice(0, 500);
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  method: "GET" | "POST",
  path: string,
): Promise<Response> {
  let lastErr: unknown;
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      // Retry on transient upstream errors only.
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        lastStatus = res.status;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      // Non-retryable error — surface as ToolError immediately.
      throw new ToolError(await readErrorMessage(res), res.status);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ToolError) throw e;
      lastErr = e;
      const errName = (e as Error).name;
      const isAbort = errName === "AbortError";
      // Retry network-level failures (DNS, ECONNRESET, timeouts)
      if (attempt < MAX_RETRIES && (isAbort || errName === "TypeError" || errName === "FetchError")) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      if (isAbort) {
        throw new ToolError(
          `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path}`,
        );
      }
      throw new ToolError(`Network error calling ${path}: ${(e as Error).message}`);
    }
  }
  // Loop exhausted with retries exhausted on transient status code.
  throw new ToolError(
    `Upstream returned ${lastStatus ?? "error"} after ${MAX_RETRIES + 1} attempts: ${method} ${path}`,
    lastStatus ?? undefined,
  );
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: buildHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
    "POST",
    path,
  );
  return (await res.json()) as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetchWithRetry(url, { headers: buildHeaders() }, "GET", path);
  return (await res.json()) as T;
}
