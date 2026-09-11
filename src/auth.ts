/**
 * Credentials for the MCP client.
 *
 * WHY A DEVICE FLOW AND NOT A PROMPT
 * ----------------------------------
 * This server speaks JSON-RPC over stdio. stdout IS the protocol channel, so
 * printing a login prompt corrupts it, and there is no TTY to read a password
 * from — the process is a child of Cursor or Claude Code. It cannot open a
 * browser either.
 *
 * So sign-in happens somewhere else and this process waits: it returns a short
 * code inside a TOOL RESULT, the agent shows that to the human, and we poll
 * until it is approved. Same shape as `gh auth login`, different plumbing.
 *
 * The install id is deliberately the EXISTING session id from session.ts — a
 * randomUUID persisted at ~/.fetchsandbox/session.json since long before this
 * file existed. Minting a second machine identifier would have split every
 * metric across two ids for no gain.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionId } from "./session.js";

const DIR = join(homedir(), ".fetchsandbox");
const CREDS_FILE = join(DIR, "credentials.json");

export interface Credentials {
  apiKey: string;
  email: string;
  createdAt: string;
}

let cached: Credentials | null | undefined;

/** The durable per-machine id. Reuses session.ts rather than minting a second. */
export function installId(): string | undefined {
  return getSessionId();
}

export function readCredentials(): Credentials | null {
  if (cached !== undefined) return cached;
  // An env var wins, so CI and containers never need a writable home dir.
  const fromEnv = process.env.FETCHSANDBOX_API_KEY;
  if (fromEnv) {
    cached = { apiKey: fromEnv, email: "", createdAt: "" };
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(CREDS_FILE, "utf8")) as Partial<Credentials>;
    cached =
      typeof parsed?.apiKey === "string" && parsed.apiKey
        ? { apiKey: parsed.apiKey, email: parsed.email ?? "", createdAt: parsed.createdAt ?? "" }
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function writeCredentials(c: Credentials): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
    // 0600. A long-lived key must not be world-readable on a shared machine.
    chmodSync(CREDS_FILE, 0o600);
  } catch {
    // Best-effort: an unwritable home means re-authing next run, not a crash.
  }
  cached = c;
}

export function clearCredentials(): void {
  cached = null;
}
