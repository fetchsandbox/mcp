import { postJson, ToolError } from "../client.js";

export interface RunAllWorkflowsInput {
  sandbox_id: string;
  workflow_names?: string[];
}

interface BatchStepResult {
  name?: string;
  description?: string;
  status?: string;
  detail?: string;
  duration_ms?: number;
  data?: unknown;
}

interface BatchWorkflowResult {
  workflow_id: string;
  name?: string;
  passed: boolean;
  steps_total?: number;
  steps_passed?: number;
  total_duration_ms?: number;
  steps?: BatchStepResult[];
  error?: string;
}

interface BackendBatchResponse {
  spec_id: string;
  sandbox_id: string;
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  results: BatchWorkflowResult[];
}

export interface NormalizedBatchResult {
  sandbox_id: string;
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  summary: Array<{
    workflow_id: string;
    status: "pass" | "fail";
    steps_passed: number;
    steps_total: number;
    duration_ms: number;
  }>;
  results: BatchWorkflowResult[];
}

export const runAllWorkflowsTool = {
  name: "run_all_workflows",
  description:
    "Execute EVERY workflow (or a scoped subset) for a sandbox in ONE call. " +
    "Use this — NOT a loop of run_workflow — for any validation-style request: " +
    "\"validate this integration\", \"run all workflows\", \"check coverage\", " +
    "\"test stripe checkout\", \"fs validate\". IDEs (Cursor, Claude Code) " +
    "approve each MCP call individually, so 18 workflows via run_workflow = " +
    "18 clicks. This tool = 1 click, total. " +
    "Scope via `workflow_names`: pass an array of workflow ids to run a " +
    "subset (e.g., user says \"validate stripe CHECKOUT\" → pass " +
    "[\"create_checkout_session\", \"checkout_complete\"]). Names are " +
    "case-insensitive; dashes and underscores interchangeable. " +
    "Returns: summary (pass/fail counts, totals) + full step trace per " +
    "workflow. After running, the user can visit " +
    "fetchsandbox.com/runs/<sandbox_id> for a shareable visual timeline.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: {
        type: "string",
        description: "The sandbox_id returned by import_spec.",
      },
      workflow_names: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of workflow ids/names to run. Case-insensitive; " +
          "dashes and underscores are interchangeable. Omit to run every " +
          "workflow for the spec.",
      },
    },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
} as const;

export async function runRunAllWorkflows(
  input: RunAllWorkflowsInput,
): Promise<NormalizedBatchResult> {
  if (!input.sandbox_id) throw new ToolError("sandbox_id is required.");
  const path = `/api/sandboxes/${encodeURIComponent(input.sandbox_id)}/workflows/run-all`;
  const body: Record<string, unknown> = {};
  if (input.workflow_names && input.workflow_names.length > 0) {
    body.workflow_names = input.workflow_names;
  }
  const raw = await postJson<BackendBatchResponse>(path, body);
  const summary = (raw.results ?? []).map((r) => ({
    workflow_id: r.workflow_id,
    status: r.passed ? ("pass" as const) : ("fail" as const),
    steps_passed: r.steps_passed ?? 0,
    steps_total: r.steps_total ?? 0,
    duration_ms: r.total_duration_ms ?? 0,
  }));
  return {
    sandbox_id: raw.sandbox_id,
    total: raw.total,
    passed: raw.passed,
    failed: raw.failed,
    duration_ms: raw.duration_ms,
    summary,
    results: raw.results ?? [],
  };
}
