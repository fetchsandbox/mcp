/**
 * Async job helper for the long-running tools (find_bugs / fix_bug).
 *
 * The backend analysis runs ~2 min — past Cloudflare's ~100s origin timeout —
 * so we START a job (fast POST → job_id) then POLL a fast GET until it finishes.
 * Every HTTP call is short, so nothing hits the CF timeout.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getJson, postJson, ToolError } from "../client.js";

interface JobStart {
  job_id?: string;
  status?: string;
  error?: string;
}

export interface JobStatus {
  status: string; // running | done | error
  error?: string | null;
  [k: string]: unknown;
}

// Bound each MCP response, not the existing backend task. Direct library users
// retain the existing blocking contract; concurrent requests have isolated budgets.
const responseBudget = new AsyncLocalStorage<number>();
export function withJobResponseBudget<T>(ms: number, action: () => Promise<T>): Promise<T> {
  return responseBudget.run(ms, action);
}
export interface PendingJob {
  status: "running";
  job_id: string;
  next_tool_call: { name: "get_job"; arguments: { job_id: string } };
  agent_guidance: string;
}
export function pendingJob(jobId: string): PendingJob {
  return {status: "running", job_id: jobId,
    next_tool_call: {name: "get_job", arguments: {job_id: jobId}},
    agent_guidance: "The SAME backend job is still running. Call get_job with this job_id until done. Do not start another job, apply the proposed fix, or claim a pass while it is running."};
}
export const getJobTool = {
  name: "get_job",
  description: "Retrieve the SAME running find_bugs, fix_bug, prove_fix or verify_behavior job. Follow next_tool_call until status is done or error. Never restart the original tool to poll. A running response is not proof; only the completed measured verdict and receipt can establish a pass.",
  inputSchema: {type: "object", properties: {job_id: {type: "string", description: "Exact job_id returned by the original call."}}, required: ["job_id"], additionalProperties: false},
} as const;
export async function runGetJob(jobId: string): Promise<JobStatus> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new ToolError("Invalid job_id");
  return withJobResponseBudget(20_000, () => pollJob(jobId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startAndPoll(
  startPath: string,
  body: unknown,
  opts?: { maxMs?: number; intervalMs?: number },
): Promise<JobStatus> {
  const maxMs = opts?.maxMs ?? 15 * 60_000;
  const intervalMs = opts?.intervalMs ?? 4000;

  const start = await postJson<JobStart>(startPath, body);
  if (!start.job_id) {
    throw new ToolError(`Could not start job: ${start.error ?? "no job_id returned"}`);
  }
  return pollJob(start.job_id, { maxMs, intervalMs, startPath });
}

/** Poll one already-started job to completion.
 *
 * Split out of startAndPoll so a caller that must inspect the START response
 * first can still share this loop. verify_behavior needs that: a backend
 * without async support silently ignores the opt-in flag and answers the start
 * call with the finished simulation, so the client has to look before it polls
 * — otherwise publishing the client ahead of the deploy breaks every call.
 */
export async function pollJob(
  jobId: string,
  opts?: { maxMs?: number; intervalMs?: number; startPath?: string },
): Promise<JobStatus> {
  const maxMs = opts?.maxMs ?? 15 * 60_000;
  const intervalMs = opts?.intervalMs ?? 4000;
  const budget = Math.min(maxMs, responseBudget.getStore() ?? maxMs);
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const st = await getJson<JobStatus>(`/api/mcp/jobs/${jobId}`);
    if (st.status !== "running") return st;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  if (budget < maxMs) return {...pendingJob(jobId)};
  throw new ToolError(
    `Timed out after ${Math.round(maxMs / 60000)}min waiting on ` +
      `${opts?.startPath ?? "job " + jobId}.`,
  );
}
