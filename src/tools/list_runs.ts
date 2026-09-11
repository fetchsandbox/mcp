import { getJson, ToolError, getBaseUrl } from "../client.js";

interface BackendFlow {
  flow_run_id: string;
  started_at?: string;
  last_activity_at?: string;
  event_counts?: { request?: number; webhook?: number };
  status?: string;
  workflow?: { id?: string; name?: string } | null;
}

interface BackendFlowsResponse {
  flows: BackendFlow[];
  total_count?: number;
}

export interface ListRunsInput {
  sandbox_id: string;
  limit?: number;
}

export interface RunSummary {
  flow_run_id: string;
  workflow_name: string;
  status: string;
  started_at: string;
  last_activity_at: string;
  request_count: number;
  webhook_count: number;
  share_url: string;
}

export interface ListRunsResponse {
  sandbox_id: string;
  total: number;
  runs: RunSummary[];
}

export const listRunsTool = {
  name: "list_runs",
  description:
    "List recent workflow runs (and ad-hoc traffic) for a sandbox, newest " +
    "first. Use when the user asks 'what did I run', 'show me recent " +
    "validation runs', 'did the stripe test pass earlier', or wants to " +
    "find a previous run to share or re-inspect. Each run includes its " +
    "shareable timeline URL (fetchsandbox.com/runs/<sandbox_id>) so the " +
    "user can open the visual trace in a browser or drop it in Slack / a " +
    "PR comment. Requires sandbox_id (from import_spec).",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: {
        type: "string",
        description: "The sandbox_id returned by import_spec.",
      },
      limit: {
        type: "number",
        description:
          "Max number of runs to return (default 20, server may cap).",
      },
    },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
} as const;

export async function runListRuns(
  input: ListRunsInput,
): Promise<ListRunsResponse> {
  if (!input.sandbox_id) throw new ToolError("sandbox_id is required.");
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const path = `/api/sandboxes/${encodeURIComponent(input.sandbox_id)}/flows?limit=${limit}`;
  const raw = await getJson<BackendFlowsResponse>(path);
  const flows = Array.isArray(raw.flows) ? raw.flows : [];
  // The backend composes receipt URLs from FETCHSANDBOX_PUBLIC_URL (app/config.py
  // ::receipt_base_url), so a self-hosted or staging deployment gets links that
  // resolve. This tool built its own URL and hardcoded prod, which meant the one
  // place we hand a user a "here is the proof" link pointed at a 404 for every
  // non-prod deployment. Derive it from the configured base instead.
  const shareBase = `${getBaseUrl()}/runs/${encodeURIComponent(input.sandbox_id)}`;
  const runs: RunSummary[] = flows.map((f) => ({
    flow_run_id: f.flow_run_id,
    workflow_name: f.workflow?.name || f.workflow?.id || "(ad-hoc)",
    status: f.status || "unknown",
    started_at: f.started_at || "",
    last_activity_at: f.last_activity_at || "",
    request_count: f.event_counts?.request ?? 0,
    webhook_count: f.event_counts?.webhook ?? 0,
    share_url: `${shareBase}#${encodeURIComponent(f.flow_run_id)}`,
  }));
  return {
    sandbox_id: input.sandbox_id,
    total: raw.total_count ?? runs.length,
    runs,
  };
}
