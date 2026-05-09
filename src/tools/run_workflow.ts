import { postJson, ToolError } from "../client.js";

export interface RunWorkflowInput {
  sandbox_id: string;
  workflow_name: string;
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
  flow_name?: string;
  flow_description?: string;
  passed?: boolean;
  total_duration_ms?: number;
  steps?: BackendStepResult[];
  [key: string]: unknown;
}

export interface NormalizedRunResult {
  workflow_name: string;
  description: string;
  status: "pass" | "fail";
  total_duration_ms: number;
  steps_passed: number;
  steps_total: number;
  steps: BackendStepResult[];
}

export const runWorkflowTool = {
  name: "run_workflow",
  description:
    "Execute one workflow against a previously-imported sandbox and return the " +
    "step-by-step request/response trace. Each step shows the HTTP call, the " +
    "schema-validated response body, and whether the step passed. Template " +
    "variables (e.g. {{step1.id}}) are resolved automatically between steps so " +
    "later steps can reference IDs returned by earlier ones. Use this after " +
    "list_workflows when the user picks one, or directly if they name a " +
    "specific workflow.",
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
  const raw = await postJson<BackendRunResult>(path, {});
  const steps = raw.steps ?? [];
  const passedSteps = steps.filter((s) => s.status === "passed").length;
  return {
    workflow_name: raw.flow_name ?? input.workflow_name,
    description: raw.flow_description ?? "",
    status: raw.passed ? "pass" : "fail",
    total_duration_ms: raw.total_duration_ms ?? 0,
    steps_passed: passedSteps,
    steps_total: steps.length,
    steps,
  };
}
