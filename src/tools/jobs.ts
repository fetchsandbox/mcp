/**
 * Async job helper for the long-running tools (find_bugs / fix_bug).
 *
 * The backend analysis runs ~2 min — past Cloudflare's ~100s origin timeout —
 * so we START a job (fast POST → job_id) then POLL a fast GET until it finishes.
 * Every HTTP call is short, so nothing hits the CF timeout.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getJson, postJsonLong, ToolError } from "../client.js";

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
  return responseBudget.run(Math.min(responseBudget.getStore() ?? Infinity, Date.now() + ms), action);
}
export interface PendingJob {
  status: "running";
  job_id: string;
  next_tool_call: { name: "get_job"; arguments: { job_id: string } };
  agent_guidance: string;
  elapsed_s?: number;
  job_kind?: string;
}
export function pendingJob(jobId: string, progress?: JobStatus): PendingJob {
  const elapsed = progress?.elapsed_s;
  const facts = typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0
    ? {elapsed_s: elapsed, ...(typeof progress?.job_kind === "string" && /^[a-z_]{1,40}$/.test(progress.job_kind) ? {job_kind: progress.job_kind} : {})} : {};
  return {status: "running", job_id: jobId,
    next_tool_call: {name: "get_job", arguments: {job_id: jobId}},
    ...facts,
    agent_guidance: "No completed result has been received for this SAME backend job. Call get_job with this job_id until done. Do not start another job, apply the proposed fix, or claim a pass while awaiting its result. Only elapsed_s is measured elapsed time; do not infer a timeout from poll count or model estimates."};
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

  // Creating a task is not a read. A lost start response must not cause the
  // HTTP helper to submit a second expensive task. Reuse its no-retry path.
  let start: JobStart;
  try {
    const remaining = (responseBudget.getStore() ?? Date.now() + 30_000) - Date.now();
    if (remaining <= 0) throw new ToolError("Response budget exhausted before job submission");
    start = await postJsonLong<JobStart>(startPath, body, Math.min(30_000, remaining));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    throw new ToolError(`Could not confirm job creation; do not automatically resubmit. ${detail}`,
      error instanceof ToolError ? error.status : undefined,
      error instanceof ToolError ? error.authReason : undefined);
  }
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
  const budget = Math.min(maxMs, Math.max(0, (responseBudget.getStore() ?? Date.now() + maxMs) - Date.now()));
  const deadline = Date.now() + budget;
  let progress: JobStatus | undefined;
  while (Date.now() < deadline) {
    let st: JobStatus;
    try {
      st = await getJson<JobStatus>(`/api/mcp/jobs/${jobId}`, {timeoutMs: Math.max(1, deadline - Date.now())});
    } catch (error) {
      if (Date.now() >= deadline) {
        if (budget < maxMs) return {...pendingJob(jobId, progress), poll_read_timed_out: true};
        break;
      }
      throw error;
    }
    if (st.status !== "running") return st;
    progress = st;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  if (budget < maxMs) return {...pendingJob(jobId, progress)};
  throw new ToolError(
    `Timed out after ${Math.round(maxMs / 60000)}min waiting on ` +
      `${opts?.startPath ?? "job " + jobId}.`,
  );
}
