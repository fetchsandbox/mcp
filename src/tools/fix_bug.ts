/**
 * fix_bug — FetchSandbox grounded REMEDIATION for a specific bug.
 *
 * The "fix" step of investigate→fix→prove. Given a bug that find_bugs surfaced,
 * ships the project to the FetchSandbox runtime, which authors a MINIMAL fix —
 * grounded by the brain's remediation pattern for that failure class — and
 * returns a `git diff` PROPOSAL. The user's working tree is never modified; the
 * agent reviews the diff and applies it.
 *
 * Calls POST /api/mcp/fix_bug. The diff is NOT a proof — after applying it,
 * prove the fix with submit_proof / verify_behavior so the receipt can claim a
 * measured buggy→fixed flip. FetchSandbox proposes; the gate certifies.
 */
import { ToolError } from "../client.js";
import { startAndPoll } from "./jobs.js";
import { packDirToBase64, resolveWorkspaceDir } from "./pack.js";

export interface FixBugInput {
  bug: string; // the specific bug to fix (file:line + description)
  fix_pattern?: string; // optional grounding: known remediation for this class
  path?: string;
  spec?: string;
  timeout_s?: number;
}

interface FixBugResponse {
  available: boolean;
  diff?: string | null;
  summary?: string | null;
  engine?: string;
  error?: string | null;
}

export const fixBugTool = {
  name: "fix_bug",
  description:
    "FetchSandbox remediation: get a proposed fix for a specific bug in YOUR " +
    "code. The 'fix' step after find_bugs. Ships the project to the " +
    "FetchSandbox runtime, which authors a MINIMAL fix grounded in the known " +
    "remediation for that failure class and returns a git diff — it does NOT " +
    "modify your files, so review the diff and apply it yourself. IMPORTANT: " +
    "the diff is a proposal, not a proof. After applying it, prove the fix " +
    "(submit_proof / verify_behavior) so the buggy→fixed flip is measured, not " +
    "assumed. Runs for up to a few minutes.",
  inputSchema: {
    type: "object",
    properties: {
      bug: {
        type: "string",
        description:
          "The specific bug to fix — ideally 'file:line — description', taken " +
          "from a find_bugs finding.",
      },
      fix_pattern: {
        type: "string",
        description:
          "OPTIONAL. The known remediation pattern for this failure class, if " +
          "you have it (e.g. from guide's matched_bug_pattern). Improves fix " +
          "quality; the proof still certifies.",
      },
      path: {
        type: "string",
        description:
          "OPTIONAL. Absolute path to the project, as it is. Defaults to the " +
          "current working directory. Do NOT copy the project first: fix_bug " +
          "returns a diff and never writes to your tree.",
      },
      spec: {
        type: "string",
        description: "OPTIONAL. Grounding hint for the integration (e.g. 'stripe').",
      },
      timeout_s: {
        type: "number",
        description: "OPTIONAL. Fix budget in seconds (default 300, max 600).",
      },
    },
    required: ["bug"],
    additionalProperties: false,
  },
} as const;

export async function runFixBug(input: FixBugInput): Promise<{
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  available: boolean;
  diff: string | null;
  summary: string | null;
  engine: string;
  packed_bytes: number;
}> {
  if (!input.bug || !input.bug.trim()) {
    throw new ToolError("bug is required — pass the specific finding to fix.");
  }
  const dir = resolveWorkspaceDir(input.path);
  const { b64, bytes } = packDirToBase64(dir);
  const timeout_s = Math.min(Math.max(input.timeout_s ?? 300, 30), 600);
  const body: Record<string, unknown> = {
    bug: input.bug.trim(),
    workspace_tar_b64: b64,
    timeout_s,
  };
  if (input.fix_pattern && input.fix_pattern.trim()) body.fix_pattern = input.fix_pattern.trim();
  if (input.spec && input.spec.trim()) body.spec = input.spec.trim();

  // Async job: start + poll (remediation runs past Cloudflare's ~100s timeout).
  const raw = await startAndPoll("/api/mcp/fix_bug", body, {
    maxMs: (timeout_s + 180) * 1000,
  });
  if (raw.status === "error") {
    throw new ToolError(`FetchSandbox remediation failed: ${raw.error ?? "unknown error"}`);
  }
  if (raw.available !== true) {
    throw new ToolError(
      `FetchSandbox remediation is unavailable right now: ${(raw.error as string) ?? "unknown error"}`,
    );
  }
  return {
    available: true,
    diff: (raw.diff as string | null) ?? null,
    // Forward the server's typed next step. These clients whitelist fields, so
    // a server-side addition is invisible here unless it is named — which is
    // how find_bugs shipped for a month as "the first step of an
    // investigate->fix->prove flow" that returned no step two.
    next_actions: raw.next_actions ?? undefined,
    prove_instructions: (raw.prove_instructions as string | undefined) ?? undefined,
    summary: (raw.summary as string | null) ?? null,
    engine: (raw.engine as string) ?? "fetchsandbox",
    packed_bytes: bytes,
  };
}
