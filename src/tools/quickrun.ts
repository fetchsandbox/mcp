import { ToolError, postJson } from "../client.js";
import { rememberTwin } from "../twin.js";

/**
 * One-call run against a KNOWN/bundled spec — no import_spec, no sandbox setup.
 *
 * This is the primitive that makes the brownfield flow work from a bare prompt:
 * the user has an app that integrates a well-known provider (Stripe, Clerk, …),
 * they ask to test it, `guide` resolves the spec + workflow, and this spins up
 * the bundled sandbox by slug and runs the workflow in one shot — returning the
 * sandbox_id + flow_run_id needed to then prove the fix with verify_behavior.
 *
 * Calls POST /api/mcp/quickrun/{spec_slug}/{workflow_name}.
 */

export interface QuickrunInput {
  spec_slug: string;
  workflow_name: string;
  scenario?: string;
}

interface RunVerdict {
  state?: string;
  scenario?: string | null;
  proven?: boolean | null;
  reason?: string;
}

interface BackendQuickrunResult {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  flow_name?: string;
  flow_description?: string;
  flow_run_id?: string;
  sandbox_id?: string;
  passed?: boolean;
  total_duration_ms?: number;
  steps?: Array<{ status?: string }>;
  timeline_url?: string;
  share_url?: string;
  verdict?: RunVerdict;
}

export interface NormalizedQuickrunResult {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  spec_slug: string;
  workflow_name: string;
  status: "pass" | "fail";
  steps_passed: number;
  steps_total: number;
  total_duration_ms: number;
  sandbox_id?: string;
  flow_run_id?: string;
  share_url?: string;
  // Honest verdict: `status` = "did the requests succeed", but for a failure-
  // scenario run `verdict.proven` is false — the run does NOT prove the user's
  // handler survives the fault (use verify_behavior / prove_fix). Surfaced so the
  // agent can't read a scenario "pass" as a green (tester finding: false-green).
  verdict?: RunVerdict;
}

export const quickrunTool = {
  name: "quickrun",
  description:
    "Run a curated proof workflow against a KNOWN, bundled spec (stripe, clerk, " +
    "descope, resend, twilio, and 50+ others) in ONE call — it spins up the " +
    "sandbox by slug, so you do NOT need import_spec or a sandbox_id first. " +
    "This is the normal path when the user is testing an integration with a " +
    "well-known provider: call `guide` on their prompt, then call `quickrun` " +
    "with the returned spec + workflow. To reproduce a failure, pass the " +
    "`scenario` from guide's matched_bug_pattern.reproduce_with.scenario (e.g. " +
    "webhook_retries, payment_declined). Returns sandbox_id + flow_run_id — pass " +
    "BOTH to verify_behavior to prove the fix — plus a receipt URL. Use " +
    "run_workflow instead ONLY when you already hold a sandbox_id from " +
    "import_spec of a custom/private spec.",
  inputSchema: {
    type: "object",
    properties: {
      spec_slug: {
        type: "string",
        description: "The bundled spec slug from guide (e.g. 'stripe'). Lowercase.",
      },
      workflow_name: {
        type: "string",
        description: "The workflow id from guide (e.g. 'accept_payment').",
      },
      scenario: {
        type: "string",
        description:
          "OPTIONAL failure scenario to reproduce (e.g. webhook_retries, " +
          "payment_declined). Take it from guide's matched_bug_pattern." +
          "reproduce_with.scenario. Omit for the happy path.",
      },
    },
    required: ["spec_slug", "workflow_name"],
    additionalProperties: false,
  },
} as const;

export async function runQuickrun(input: QuickrunInput): Promise<NormalizedQuickrunResult> {
  if (!input.spec_slug) throw new ToolError("spec_slug is required.");
  if (!input.workflow_name) throw new ToolError("workflow_name is required.");
  const path = `/api/mcp/quickrun/${encodeURIComponent(input.spec_slug)}/${encodeURIComponent(
    input.workflow_name,
  )}`;
  const body: Record<string, unknown> = {};
  if (input.scenario && input.scenario.trim()) body.scenario = input.scenario.trim();

  const raw = await postJson<BackendQuickrunResult>(path, body);
  const steps = raw.steps ?? [];
  // Carry the twin forward: prove_fix's declared tier reads back from it,
  // and nothing else in the session knows this id exists.
  rememberTwin(raw.sandbox_id);

  // Forward any field this client does not know about. The named fields below
  // are normalized (renames, derived counts); everything else travels as-is so
  // a newer backend can surface information to the agent without waiting for a
  // client release. `steps` is dropped deliberately — it is large, and the
  // step detail belongs in the receipt, not in every tool response.
  const known = new Set([
    "flow_name", "flow_description", "flow_run_id", "sandbox_id", "passed",
    "total_duration_ms", "steps", "timeline_url", "share_url", "verdict",
  ]);
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k) && v !== undefined && v !== null) passthrough[k] = v;
  }

  return {
    ...passthrough,
    spec_slug: input.spec_slug,
    // Forward the server's typed next step. These clients whitelist fields, so
    // a server-side addition is invisible here unless it is named — which is
    // how find_bugs shipped for a month as "the first step of an
    // investigate->fix->prove flow" that returned no step two.
    next_actions: raw.next_actions ?? undefined,
    prove_instructions: raw.prove_instructions ?? undefined,
    workflow_name: raw.flow_name ?? input.workflow_name,
    status: raw.passed ? "pass" : "fail",
    steps_passed: steps.filter((s) => s.status === "passed").length,
    steps_total: steps.length,
    total_duration_ms: raw.total_duration_ms ?? 0,
    sandbox_id: raw.sandbox_id,
    flow_run_id: raw.flow_run_id,
    // quickrun returns timeline_url; normalize to share_url for parity with run_workflow.
    share_url: raw.share_url ?? raw.timeline_url,
    verdict: raw.verdict,
  };
}
