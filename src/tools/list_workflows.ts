import { getJson, ToolError } from "../client.js";

export interface ListWorkflowsInput {
  spec_id?: string;
  /** A human name like "resend". The backend's resolve_spec_id has always
   *  accepted these; only this client insisted on the hash. */
  spec_slug?: string;
  /** Inspect one exact catalog id or name without expanding every workflow. */
  workflow_name?: string;
}

export interface WorkflowItem {
  /** Keep provider-defined outcome and verification fields in detail mode. */
  [field: string]: unknown;
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

export interface CrossServiceWorkflow {
  workflow: string;
  services: string[];
  run_with: string;
}

interface BackendListWorkflowsResponse {
  workflows: WorkflowItem[];
  scenarios?: ScenarioItem[];
  cross_service_available?: CrossServiceWorkflow[];
}

export interface ListWorkflowsResponse {
  spec_id: string;
  workflows: Array<{
    [field: string]: unknown;
    id: string;
    name: string;
    description: string;
    steps_count: number;
    steps?: unknown[];
  }>;
  /** WHAT CAN GO WRONG, next to what can go right.
   *
   *  A real Lovable agent called this four times and list_scenarios zero
   *  times, so it never learned `email_bounced` existed — and the user had
   *  asked for bounce-after-payment recovery by name. The failure modes were
   *  a separate tool nothing pointed at. */
  scenarios: ScenarioItem[];
  cross_service_available?: CrossServiceWorkflow[];
}

export const listWorkflowsTool = {
  name: "list_workflows",
  description:
    "List the named, runnable workflows for a known provider slug or imported spec. " +
    "Workflows are realistic multi-step API journeys (e.g. 'create customer " +
    "→ attach payment method → create subscription'). Known provider slugs need no import. " +
    "Use this for exploration (\"what can I do?\", \"show me the flows\") " +
    "OR before run_all_workflows when the user wants a SCOPED validation: " +
    "list, filter by user intent (\"checkout\", \"webhooks\"), then pass the " +
    "matching ids as `workflow_names` to run_all_workflows. " +
    "Default results are summaries. Pass workflow_name with an exact returned id or name " +
    "to inspect that workflow's full definition, including request bodies, assertions, outcomes and invariants; this does not execute it. " +
    "Returns the workflows AND the failure scenarios this spec can " +
    "simulate — each with a plain description and the exact call to run it. " +
    "When cross_service_available is present, use each exact run_with invocation: " +
    "cross-provider workflows use the returned namespace, not this provider's slug. " +
    "These curated workflows exercise provider behavior; they do not verify the user's app. " +
    "Choose relevant scenarios from the inspected workflow and user goal; ask only about ambiguous " +
    "business requirements. Do not guess scenario names.",
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
      workflow_name: {
        type: "string",
        description: "Exact workflow id or name returned by this catalog. Returns its full definition, including steps and outcome rules, without executing it; omit for summaries.",
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
  let workflows = raw.workflows || [];
  if (input.workflow_name !== undefined) {
    const name = input.workflow_name.trim();
    const selected = workflows.filter(w => w.id === name || w.name === name);
    if (!name || selected.length === 0) {
      throw new ToolError(`No workflow exactly matches ${JSON.stringify(name)} for ${ref}. Available workflow ids/names: ${JSON.stringify(workflows.map(w => ({id: w.id, name: w.name})))}. Use an exact id or name from this catalog; cross-service workflows use their returned run_with invocation.`);
    }
    workflows = selected;
  }
  return {
    spec_id: ref,
    workflows: workflows.map((w) => ({
      ...(input.workflow_name !== undefined ? w : {}),
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
    ...(raw.cross_service_available ? {cross_service_available: raw.cross_service_available} : {}),
  };
}
