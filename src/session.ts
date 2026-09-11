/**
 * Stable per-machine session id, persisted at ~/.fetchsandbox/session.json.
 *
 * Used as X-MCP-Session-Id on every backend request so DAU is countable.
 * The id is opaque (random uuid) and reveals nothing about the machine.
 *
 * Disabled entirely when FETCHSANDBOX_TELEMETRY=0 — in that case sessionId
 * returns undefined and the client omits the header.
 *
 * Also detects the host IDE (Cursor / Claude Code / Cline / etc.) by
 * sniffing env vars + parent process. Returned as a stable token usable
 * in the user-agent string for backend cohort splits in PostHog.
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

let cachedIde: string | null = null;

/**
 * Best-effort host-IDE detection. Returns a short lowercase token:
 * "cursor" | "claude-code" | "cline" | "vscode" | "windsurf" | "chatgpt" |
 * "zed" | "unknown".
 *
 * Detection order matters — env vars are stronger signals than parent
 * process name (which can be misleading on macOS where IDEs spawn
 * launchers). Falls back to "unknown" rather than guessing.
 */
export function detectIde(): string {
  if (cachedIde !== null) return cachedIde;
  const env = process.env;

  // Cursor sets these in the MCP server's env.
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT || env.CURSOR_SESSION_ID) {
    cachedIde = "cursor";
    return cachedIde;
  }

  // Claude Code (Anthropic CLI / IDE extension).
  if (
    env.CLAUDE_CODE_SESSION_ID ||
    env.CLAUDE_CODE_PROJECT_DIR ||
    env.CLAUDECODE === "1" ||
    env.ANTHROPIC_CLI === "1"
  ) {
    cachedIde = "claude-code";
    return cachedIde;
  }

  // Windsurf (Codeium).
  if (env.WINDSURF_SESSION_ID || env.CODEIUM_WINDSURF) {
    cachedIde = "windsurf";
    return cachedIde;
  }

  // Zed.
  if (env.ZED_TERM || env.ZED_SESSION_ID) {
    cachedIde = "zed";
    return cachedIde;
  }

  // Cline runs inside VSCode; fingerprint = CLINE_* env var or
  // VSCode + a known Cline marker.
  if (env.CLINE_VERSION || env.CLINE_SESSION_ID) {
    cachedIde = "cline";
    return cachedIde;
  }

  // Generic VSCode-hosted MCP (no Cline-specific markers).
  if (env.VSCODE_PID || env.VSCODE_IPC_HOOK || env.VSCODE_INJECTION) {
    cachedIde = "vscode";
    return cachedIde;
  }

  // ChatGPT desktop.
  if (env.CHATGPT_DESKTOP || env.OPENAI_DESKTOP) {
    cachedIde = "chatgpt";
    return cachedIde;
  }

  cachedIde = "unknown";
  return cachedIde;
}
