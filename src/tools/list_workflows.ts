import { getJson, ToolError } from "../client.js";

export interface ListWorkflowsInput {
  spec_id?: string;
  /** A human name like "resend". The backend's resolve_spec_id has always
   *  accepted these; only this client insisted on the hash. */
  spec_slug?: string;
}

export interface WorkflowItem {
  id: string;
  name: string;
  description?: string;
  steps?: unknown[];
}

export interface ScenarioItem {
  id: string;
  description: string;
  how_to_run: string;
}

interface BackendListWorkflowsResponse {
  workflows: WorkflowItem[];
  scenarios?: ScenarioItem[];
}

export interface ListWorkflowsResponse {
  spec_id: string;
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    steps_count: number;
  }>;
  /** WHAT CAN GO WRONG, next to what can go right.
   *
   *  A real Lovable agent called this four times and list_scenarios zero
   *  times, so it never learned `email_bounced` existed — and the user had
   *  asked for bounce-after-payment recovery by name. The failure modes were
   *  a separate tool nothing pointed at. */
  scenarios: ScenarioItem[];
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
    "Returns the workflows AND the failure scenarios this spec can " +
    "simulate — each with a plain description and the exact call to run it. " +
    "Read the scenarios out to the user and ask which matter; do not guess " +
    "scenario names.",
  inputSchema: {
    type: "object",
    properties: {
      spec_id: {
        type: "string",
        description: "The spec_id returned by import_spec.",
      },
      spec_slug: {
        type: "string",
        description:
          "A human name like 'resend' or 'stripe'. Use this when you do not " +
          "have a spec_id — you do not need to look one up first.",
      },
    },
    additionalProperties: false,
  },
} as const;

export async function runListWorkflows(input: ListWorkflowsInput): Promise<ListWorkflowsResponse> {
  const ref = input.spec_id || input.spec_slug;
  if (!ref) throw new ToolError("Pass spec_id or spec_slug (e.g. 'resend').");
  const raw = await getJson<BackendListWorkflowsResponse>(
    `/api/specs/${encodeURIComponent(ref)}/workflows`,
  );
  return {
    spec_id: ref,
    workflows: (raw.workflows || []).map((w) => ({
      id: w.id || w.name || "",
      name: w.name || w.id || "",
      description: w.description || "",
      steps_count: Array.isArray(w.steps) ? w.steps.length : 0,
    })),
    // THE LINE THE WHOLE CHANGE EXISTS FOR. Every tool here maps the backend
    // payload field by field, so a key that is not named right here is
    // silently dropped — which is how the scenarios stayed invisible even
    // once the API returned them.
    scenarios: (raw.scenarios || []).map((s) => ({
      id: s.id,
      description: s.description || "",
      how_to_run: s.how_to_run || "",
    })),
  };
}
