/**
 * find_bugs — FetchSandbox DISCOVERY over the user's own code.
 *
 * The "investigate" step of `./fetchsandbox "seeing production bugs, fix it"`.
 * Packs the caller's project (local / uncommitted / private — never needs a
 * public git URL) and ships it to the FetchSandbox behavioral runtime, which
 * reads the code against its brain/corpus of known API-integration failure
 * classes and returns the production bugs it found.
 *
 * Calls POST /api/mcp/find_bugs. This is FetchSandbox's discovery — the agent
 * should present the findings as such, then move to fix_bug + a proof (the
 * gate), NOT stop at "here are some bugs I read in your code".
 */
import { ToolError } from "../client.js";
import { startAndPoll } from "./jobs.js";
import { packDirToBase64 } from "./pack.js";

export interface FindBugsInput {
  path?: string; // project dir to analyze; defaults to the MCP server's cwd
  spec?: string; // optional grounding hint (which API/brain), e.g. "stripe"
  timeout_s?: number;
}

interface FindBugsResponse {
  available: boolean;
  bugs?: string | null;
  engine?: string;
  error?: string | null;
}

export const findBugsTool = {
  name: "find_bugs",
  description:
    "FIRST STEP for any API-integration bug — webhooks, payments, auth, email, " +
    "SMS, subscriptions. Reach for this the moment a user reports a symptom in " +
    "an app that talks to a provider: 'customers charged twice', 'the webhook " +
    "fires but nothing happens', 'their balance is wrong', 'we keep emailing a " +
    "bounced address', 'paused but they still have access'. " +
    "Packages the current project — local, uncommitted, private, no git URL " +
    "needed — and audits it against a corpus of real, harvested API-integration " +
    "failures (idempotency, signature verification, event ordering, pagination, " +
    "rate limits, state drift) that a read of the code alone does not surface. " +
    "THIS IS A FINDING, NOT A PROOF. Every finding is a hypothesis until it is " +
    "measured on the real code. Do NOT stop here, and do NOT write your own " +
    "test to confirm one — call fix_bug for a proposed diff, then prove_fix to " +
    "measure it. The response carries `next_actions` telling you exactly what " +
    "to call next; follow it. Runs for up to a few minutes.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "OPTIONAL. Absolute path to the project to analyze. Defaults to the " +
          "current working directory. Pass the repo root for a full audit.",
      },
      spec: {
        type: "string",
        description:
          "OPTIONAL. Grounding hint for which integration to focus on (e.g. " +
          "'stripe', 'paddle', 'twilio'). Narrows the analysis to that API's " +
          "known failure classes.",
      },
      timeout_s: {
        type: "number",
        description: "OPTIONAL. Analysis budget in seconds (default 300, max 600).",
      },
    },
    additionalProperties: false,
  },
} as const;

// THE RETURN TYPE IS THE WHITELIST. Every field the agent will ever see has to
// be named here, so a field added anywhere upstream is dropped by omission and
// the compiler calls the addition an error rather than the loss. That is how
// next_actions survived three hops and died at the fourth.
export async function runFindBugs(input: FindBugsInput): Promise<{
  available: boolean;
  bugs: string | null;
  next_actions?: unknown;
  prove_instructions?: unknown;
  engine: string;
  packed_bytes: number;
  /** Backend-authored sign-in line. Declared here or tsc drops it. */
  notice?: string;
}> {
  const dir = input.path && input.path.trim() ? input.path.trim() : process.cwd();
  const { b64, bytes } = packDirToBase64(dir);
  const timeout_s = Math.min(Math.max(input.timeout_s ?? 300, 30), 600);
  const body: Record<string, unknown> = {
    workspace_tar_b64: b64,
    timeout_s,
  };
  if (input.spec && input.spec.trim()) body.spec = input.spec.trim();

  // Async job: start + poll (analysis runs past Cloudflare's ~100s timeout).
  const raw = await startAndPoll("/api/mcp/find_bugs", body, {
    maxMs: (timeout_s + 180) * 1000,
  });
  if (raw.status === "error") {
    throw new ToolError(`FetchSandbox discovery failed: ${raw.error ?? "unknown error"}`);
  }
  if (raw.available !== true) {
    throw new ToolError(
      `FetchSandbox discovery is unavailable right now: ${(raw.error as string) ?? "unknown error"}`,
    );
  }
  return {
    available: true,
    bugs: (raw.bugs as string | null) ?? null,
    // THE FOURTH WHITELIST, and the one that undid the other three. Phalanx ->
    // backend -> /jobs -> HERE -> the agent. The backend comment at hop three
    // reads "Adding next_actions in _work() and forwarding it in the client was
    // not enough" -- someone traced three hops and fixed them, and this return
    // silently discarded the result. This tool's own description twelve lines
    // above promises "the response carries next_actions telling you exactly
    // what" and then did not carry them.
    //
    // Measured 2026-09-09: five personas, next_actions absent from every
    // find_bugs result, quickrun called zero times. The routing existed at every
    // layer except the one the agent reads.
    next_actions: raw.next_actions ?? undefined,
    // THE FIFTH WHITELIST. Every field the backend adds must be named
    // here or it is invisible — this is what hid next_actions for weeks.
    notice: (raw.notice as string) ?? undefined,
    prove_instructions: raw.prove_instructions ?? undefined,
    engine: (raw.engine as string) ?? "fetchsandbox",
    packed_bytes: bytes,
  };
}
