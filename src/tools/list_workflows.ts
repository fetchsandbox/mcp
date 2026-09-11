import { getJson, ToolError } from "../client.js";

export interface ListWorkflowsInput {
  spec_id: string;
}

export interface WorkflowItem {
  id: string;
  name: string;
  description?: string;
  steps?: unknown[];
}

interface BackendListWorkflowsResponse {
  workflows: WorkflowItem[];
}

export interface ListWorkflowsResponse {
  spec_id: string;
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    steps_count: number;
  }>;
}

export const listWorkflowsTool = {
  name: "list_workflows",
  description:
    "List the named, runnable workflows for a previously-imported spec. " +
    "Workflows are realistic multi-step API journeys (e.g. 'create customer " +
    "→ attach payment method → create subscription'). Use this after " +
    "import_spec for exploration (\"what can I do?\", \"show me the flows\") " +
    "OR before run_all_workflows when the user wants a SCOPED validation: " +
    "list, filter by user intent (\"checkout\", \"webhooks\"), then pass the " +
    "matching ids as `workflow_names` to run_all_workflows. " +
    "Returns: id, name, description, and step count per workflow.",
  inputSchema: {
    type: "object",
    properties: {
      spec_id: {
        type: "string",
        description: "The spec_id returned by import_spec.",
      },
    },
    required: ["spec_id"],
    additionalProperties: false,
  },
} as const;

export async function runListWorkflows(input: ListWorkflowsInput): Promise<ListWorkflowsResponse> {
  if (!input.spec_id) throw new ToolError("spec_id is required.");
  const raw = await getJson<BackendListWorkflowsResponse>(
    `/api/specs/${encodeURIComponent(input.spec_id)}/workflows`,
  );
  return {
    spec_id: input.spec_id,
    workflows: (raw.workflows || []).map((w) => ({
      id: w.id || w.name || "",
      name: w.name || w.id || "",
      description: w.description || "",
      steps_count: Array.isArray(w.steps) ? w.steps.length : 0,
    })),
  };
}
