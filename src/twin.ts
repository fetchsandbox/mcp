/**
 * The twin this session last stood up.
 *
 * `quickrun` / `run_workflow` resolve a provider twin and return its
 * `sandbox_id`. `prove_fix` can read back from that same twin — but only if it
 * is told which one, and nothing carried it across tool calls, so every
 * prove_fix arrived with no twin and its declared tier (the reviewed
 * `invariant_check` from brain.yaml) declined every time. Measured on prod
 * 2026-09-08: 11 of 12 runs declined for "no twin supplied".
 *
 * The MCP server is a long-lived stdio process, so module state is exactly the
 * lifetime we want: one IDE session. Nothing is persisted to disk — a new
 * session starts with no twin, which is the correct default.
 *
 * DELIBERATELY NOT VALIDATED HERE. Whether the remembered twin is the right
 * PROVIDER for a given bug is decided server-side, where `_spec_hint` already
 * derives the provider from the bug text. A second copy of that mapping in
 * TypeScript is a second thing to drift. The client's whole job is to report
 * what it has; the server decides whether to use it.
 */

let lastSandboxId: string | undefined;

/** Record a twin this session just exercised. Ignores empty values. */
export function rememberTwin(sandboxId: string | undefined | null): void {
  if (typeof sandboxId === "string" && sandboxId.trim()) {
    lastSandboxId = sandboxId.trim();
  }
}

/** The twin this session last exercised, or undefined if none yet. */
export function lastTwin(): string | undefined {
  return lastSandboxId;
}

/** Test seam — never called in normal operation. */
export function __resetTwin(): void {
  lastSandboxId = undefined;
}
