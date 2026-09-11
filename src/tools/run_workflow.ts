import { postJson, ToolError } from "../client.js";
import { rememberTwin } from "../twin.js";

export interface RunWorkflowInput {
  sandbox_id: string;
  workflow_name: string;
  scenario?: string;
}

interface BackendStepResult {
  name?: string;
  description?: string;
  status?: string;
  detail?: string;
  duration_ms?: number;
  data?: unknown;
}

interface BackendRunResult {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  flow_name?: string;
  flow_description?: string;
  flow_run_id?: string;
  sandbox_id?: string;
  share_url?: string;
  passed?: boolean;
  total_duration_ms?: number;
  steps?: BackendStepResult[];
  [key: string]: unknown;
}

export interface NormalizedRunResult {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  workflow_name: string;
  description: string;
  status: "pass" | "fail";
  total_duration_ms: number;
  steps_passed: number;
  steps_total: number;
  steps: BackendStepResult[];
  // Public, replayable proof URL — paste in PRs, Slack, blog posts.
  // Renders the full timeline (requests, responses, webhook events) for
  // this specific run. No auth required to view. This is the canonical
  // "here's what happened" artifact — surface it verbatim to the user.
  share_url?: string;
  // Stable identifier for this specific run. Combine with sandbox_id to
  // reconstruct the share URL: https://fetchsandbox.com/runs/<sb>?flow=<id>
  flow_run_id?: string;
  // Sandbox identifier the run executed against.
  sandbox_id?: string;
  // Honest verdict: `status` = requests succeeded, but for a failure-scenario
  // run `verdict.proven` is false — this run does NOT prove the user's handler
  // survives the fault (use verify_behavior / prove_fix). Surfaced so a scenario
  // "pass" is never read as a green (tester finding: false-green).
  verdict?: { state?: string; scenario?: string | null; proven?: boolean | null; reason?: string };
}

export const runWorkflowTool = {
  name: "run_workflow",
  description:
    "Execute ONE specific workflow by name and return its step-by-step trace " +
    "PLUS a `share_url` — a public, replayable proof URL that renders the " +
    "full timeline (every request, response, webhook event) for this run. " +
    "The share_url is the canonical 'here's what happened' artifact: surface " +
    "it verbatim in any reply that needs evidence (PR comments, Slack " +
    "threads, blog posts, X replies). Do NOT substitute a docs URL or any " +
    "other link as the proof — the share_url is the only valid receipt. " +
    "Use ONLY when the user explicitly names a single workflow to run (e.g., " +
    "\"run accept_payment\", \"just check the refund workflow\"). For ANY " +
    "validation-style request — \"validate stripe\", \"check coverage\", \"run " +
    "all workflows\", \"test this integration\", or even \"validate stripe " +
    "checkout\" (multiple workflows match \"checkout\") — use " +
    "`run_all_workflows` instead. The batch tool collapses N approvals to 1 " +
    "and supports a workflow_names filter for scope. Calling this in a loop " +
    "is an anti-pattern.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: {
        type: "string",
        description: "The sandbox_id returned by import_spec.",
      },
      workflow_name: {
        type: "string",
        description:
          "Workflow id or name from list_workflows. Case-insensitive; dashes and " +
          "underscores are interchangeable.",
      },
      scenario: {
        type: "string",
        description:
          "OPTIONAL failure scenario to exercise (e.g. payment_declined, " +
          "insufficient_funds, fraud_hold). Toggles the sandbox engine's " +
          "scenario for the duration of the run, then restores. Use this for " +
          "'test with declined card' / 'simulate failure X' intents. Omit " +
          "for the happy path.",
      },
    },
    required: ["sandbox_id", "workflow_name"],
    additionalProperties: false,
  },
} as const;

export async function runRunWorkflow(input: RunWorkflowInput): Promise<NormalizedRunResult> {
  if (!input.sandbox_id) throw new ToolError("sandbox_id is required.");
  if (!input.workflow_name) throw new ToolError("workflow_name is required.");
  const path = `/api/sandboxes/${encodeURIComponent(input.sandbox_id)}/workflows/${encodeURIComponent(
    input.workflow_name,
  )}/run`;
  const body: Record<string, unknown> = {};
  if (input.scenario && input.scenario.trim()) {
    body.scenario = input.scenario.trim();
  }
  const raw = await postJson<BackendRunResult>(path, body);
  const steps = raw.steps ?? [];
  // Carry the twin forward: prove_fix's declared tier reads back from it,
  // and nothing else in the session knows this id exists.
  rememberTwin(raw.sandbox_id);
  const passedSteps = steps.filter((s) => s.status === "passed").length;
  return {
    workflow_name: raw.flow_name ?? input.workflow_name,
    // Forward the server's typed next step. These clients whitelist fields, so
    // a server-side addition is invisible here unless it is named — which is
    // how find_bugs shipped for a month as "the first step of an
    // investigate->fix->prove flow" that returned no step two.
    next_actions: raw.next_actions ?? undefined,
    prove_instructions: raw.prove_instructions ?? undefined,
    description: raw.flow_description ?? "",
    status: raw.passed ? "pass" : "fail",
    total_duration_ms: raw.total_duration_ms ?? 0,
    steps_passed: passedSteps,
    steps_total: steps.length,
    steps,
    share_url: raw.share_url,
    flow_run_id: raw.flow_run_id,
    sandbox_id: raw.sandbox_id ?? input.sandbox_id,
    verdict: raw.verdict as NormalizedRunResult["verdict"],
  };
}
