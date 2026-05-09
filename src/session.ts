/**
 * Stable per-machine session id, persisted at ~/.fetchsandbox/session.json.
 *
 * Used as X-MCP-Session-Id on every backend request so DAU is countable.
 * The id is opaque (random uuid) and reveals nothing about the machine.
 *
 * Disabled entirely when FETCHSANDBOX_TELEMETRY=0 — in that case sessionId
 * returns undefined and the client omits the header.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_DIR = join(homedir(), ".fetchsandbox");
const SESSION_FILE = join(SESSION_DIR, "session.json");

let cached: string | undefined | null = null; // null = not yet loaded

export function telemetryEnabled(): boolean {
  return process.env.FETCHSANDBOX_TELEMETRY !== "0";
}

export function getSessionId(): string | undefined {
  if (!telemetryEnabled()) return undefined;
  if (cached !== null) return cached ?? undefined;
  try {
    const raw = readFileSync(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string") {
      cached = parsed.id;
      return cached!;
    }
  } catch {
    // fall through to creation
  }
  const id = randomUUID();
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort; if we can't write, still return the id for this run
  }
  cached = id;
  return cached;
}
