/**
 * Async job helper for the long-running tools (find_bugs / fix_bug).
 *
 * The backend analysis runs ~2 min — past Cloudflare's ~100s origin timeout —
 * so we START a job (fast POST → job_id) then POLL a fast GET until it finishes.
 * Every HTTP call is short, so nothing hits the CF timeout.
 */
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
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const st = await getJson<JobStatus>(`/api/mcp/jobs/${jobId}`);
    if (st.status !== "running") return st;
  }
  throw new ToolError(
    `Timed out after ${Math.round(maxMs / 60000)}min waiting on ` +
      `${opts?.startPath ?? "job " + jobId}.`,
  );
}
