import { postJson } from "../client.js";

/**
 * `submit_proof` — attach REAL before/after evidence to the receipt.
 *
 * verify_behavior proves the PATTERN against FetchSandbox reference handlers.
 * This proves the FIX against the USER's ACTUAL app: after you apply the fix,
 * run their app against the scenario's probes twice — once on the pre-fix code
 * (bug reproduces) and once on the fixed code (bug gone) — and post the real
 * requests + responses here. The receipt then shows THEIR code's before/after,
 * not a simulation. That's the strongest proof.
 *
 * Typical flow: reproduce the bug locally (capture the buggy responses) →
 * apply the fix → re-run the same probes (capture the fixed responses) →
 * call submit_proof with both, keyed to the run's sandbox_id + flow_run_id.
 */

export interface ProofProbe {
  name: string;
  request: { method?: string; path?: string; body?: unknown };
  before: { status?: number; body?: unknown; error?: string | null };
  after: { status?: number; body?: unknown; error?: string | null };
}

export interface SubmitProofInput {
  sandbox_id: string;
  flow_run_id: string;
  bug_pattern_id: string;
  proofs: ProofProbe[];
  summary?: string;
  // Self-reported evidence only. For a MEASURED green proof, use prove_fix.
}

export interface SubmitProofResult {
  ok: boolean;
  confirmed: boolean;
  // True ONLY when the server measured a fail->pass flip on your real code.
  green_allowed?: boolean;
  proof_grade?: "measured" | "self_reported";
  verdict?: {
    state?: string;
    green_allowed?: boolean;
    reason?: string;
    label?: string;
  };
  probes: number;
  receipt_note?: string;
}

export const submitProofTool = {
  name: "submit_proof",
  description:
    "Attach REAL before/after evidence from the USER's actual app to the run " +
    "receipt. Use this AFTER you've fixed the bug and re-run the app: it makes " +
    "the receipt show their own code's behavior (before your fix vs after), " +
    "which is far stronger proof than a reference simulation. Provide one " +
    "`proofs` entry per probe you fired — the request you sent, the response " +
    "BEFORE the fix (bug reproduces), and the response AFTER the fix (bug gone) " +
    "— keyed to the run's sandbox_id + flow_run_id (from run_workflow's result). " +
    "This is SELF-REPORTED evidence: it's shown on the receipt but never counts " +
    "as a proven (green) result. For a MEASURED green proof — FetchSandbox " +
    "reproduces the bug on your real code and verifies your fix flips it — use " +
    "`prove_fix` instead.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string", description: "sandbox_id from the run_workflow result" },
      flow_run_id: { type: "string", description: "flow_run_id from the run_workflow result" },
      bug_pattern_id: {
        type: "string",
        description: "the bug_pattern id you reproduced (e.g. webhook_duplicate_side_effect)",
      },
      summary: {
        type: "string",
        description: "optional one-line description of what you ran against the app",
      },
      proofs: {
        type: "array",
        description:
          "one per probe: { name, request:{method,path,body}, before:{status,body}, after:{status,body} }. " +
          "before = pre-fix (bug reproduces), after = post-fix (bug gone).",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            request: {
              type: "object",
              properties: {
                method: { type: "string" },
                path: { type: "string" },
                body: {},
              },
            },
            before: {
              type: "object",
              properties: { status: { type: "number" }, body: {}, error: { type: "string" } },
            },
            after: {
              type: "object",
              properties: { status: { type: "number" }, body: {}, error: { type: "string" } },
            },
          },
          required: ["name", "before", "after"],
        },
      },
    },
    required: ["sandbox_id", "flow_run_id", "bug_pattern_id", "proofs"],
  },
};

export async function runSubmitProof(input: SubmitProofInput): Promise<SubmitProofResult> {
  return postJson<SubmitProofResult>("/api/mcp/submit_proof", input);
}
