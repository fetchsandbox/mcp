import { postJson, ToolError } from "../client.js";
import { pollJob } from "./jobs.js";

/**
 * Behavioral proof — the "prove the fix" half of reproduce→prove.
 *
 * Given a bug_pattern that declares a `simulation:` block, the backend spawns
 * two reference handler containers (a buggy one and a fixed one), fires the
 * pattern's probes at both, and returns the side-by-side diff — e.g. the buggy
 * handler double-charges on a duplicate webhook, the fixed one dedupes.
 *
 * Call this AFTER run_workflow reproduces a failure, to prove a known fix
 * actually survives it (not just that the failure happened). Pass sandbox_id +
 * flow_run_id from the run so the diff is saved onto that run's receipt.
 *
 * Calls POST /api/mcp/verify_behavior. The buggy/fixed handlers are
 * FetchSandbox reference implementations, NOT the user's code — the diff proves
 * the pattern is real and the brain's fix_pattern works; the user applies that
 * fix_pattern to inherit the behavior.
 */

export interface VerifyBehaviorInput {
  bug_pattern_id: string;
  prompt?: string;
  sandbox_id?: string;
  flow_run_id?: string;
}

interface BackendProbe {
  name?: string;
  buggy_response?: { status?: number; body?: string; error?: string | null };
  fixed_response?: { status?: number; body?: string; error?: string | null };
  expected_diff_observed?: boolean;
  verdict?: string;
}

interface BackendVerifyResponse {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  pattern_id?: string;
  mode?: string;
  disclaimer?: string;
  probes?: BackendProbe[];
  /** Present only for `mode: order_fuzz`, which returns no probes at all —
   *  the per-side verdict over every permutation and duplicate variant. */
  order_fuzz?: {
    confirmed?: boolean;
    confirmed_by?: string[];
    order_independence_confirmed?: boolean;
    terminal_safety_confirmed?: boolean;
    idempotency_confirmed?: boolean;
    events_tested?: string[];
    minimized_sequence?: unknown;
    buggy?: Record<string, unknown>;
    fixed?: Record<string, unknown>;
  };
  duration_ms?: number;
  error?: string | null;
  classification?: unknown;
}

export interface NormalizedVerifyResult {
  /** Typed next step from the server. Every entry point carries the exit:
   *  a finding is a hypothesis until prove_fix measures it. */
  next_actions?: unknown;
  prove_instructions?: string;
  pattern_id?: string;
  mode?: string;
  confirmed: boolean;
  /** Which property the fuzzer flipped, when the simulation was an order_fuzz.
   *  A receipt must never claim a property this run did not prove. */
  confirmed_by?: string[];
  order_fuzz?: BackendVerifyResponse["order_fuzz"];
  disclaimer?: string;
  probes: Array<{
    name?: string;
    buggy_status?: number;
    fixed_status?: number;
    // Did buggy + fixed both hit the statuses the pattern asserted for them?
    matched_expectation: boolean;
    // Did the two handlers ACTUALLY differ? This is the real "diff" — a sanity
    // probe (buggy == fixed on valid input) matches expectation but is NOT a
    // divergence, so it must read false here.
    divergent: boolean;
    verdict?: string;
  }>;
  duration_ms?: number;
}

export const verifyBehaviorTool = {
  name: "verify_behavior",
  description:
    "Prove a known fix survives a bug — the 'prove' half of reproduce→prove. " +
    "The backend spawns a buggy AND a fixed reference handler and fires the " +
    "bug_pattern's probes at both, returning the side-by-side diff (e.g. the " +
    "buggy handler double-charges on a duplicate webhook, the fixed handler " +
    "dedupes). Call this AFTER run_workflow reproduces a failure, when the " +
    "matched bug_pattern has a simulation block, to show the fix actually " +
    "holds — not just that the failure reproduced. Pass sandbox_id + " +
    "flow_run_id from the run so the diff is saved onto that run's receipt " +
    "URL. bug_pattern_id comes from guide's matched_bug_pattern. The buggy/" +
    "fixed handlers are FetchSandbox reference implementations, NOT the user's " +
    "code — apply the brain's fix_pattern to inherit the proven behavior.",
  inputSchema: {
    type: "object",
    properties: {
      bug_pattern_id: {
        type: "string",
        description:
          "The bug_pattern to prove (e.g. webhook_duplicate_side_effect). " +
          "Comes from guide's matched_bug_pattern.id or the spec's brain.",
      },
      prompt: {
        type: "string",
        description:
          "OPTIONAL. The user's own description of the symptom. For patterns " +
          "that can originate in the handler OR the provider, this classifies " +
          "which side to simulate. Omit to run both.",
      },
      sandbox_id: {
        type: "string",
        description:
          "OPTIONAL. The sandbox from the run. Pass with flow_run_id to save " +
          "the diff onto that run's receipt.",
      },
      flow_run_id: {
        type: "string",
        description:
          "OPTIONAL. The flow_run_id returned by run_workflow. Pass with " +
          "sandbox_id so the receipt URL renders the diff alongside the steps.",
      },
    },
    required: ["bug_pattern_id"],
    additionalProperties: false,
  },
} as const;

export async function runVerifyBehavior(
  input: VerifyBehaviorInput,
): Promise<NormalizedVerifyResult> {
  if (!input.bug_pattern_id) throw new ToolError("bug_pattern_id is required.");
  const body: Record<string, unknown> = { bug_pattern_id: input.bug_pattern_id };
  if (input.prompt && input.prompt.trim()) body.prompt = input.prompt.trim();
  if (input.sandbox_id) body.sandbox_id = input.sandbox_id;
  if (input.flow_run_id) body.flow_run_id = input.flow_run_id;

  // verify_behavior spawns buggy + fixed containers and fires probes at both —
  // ~30-60s, past the default 30s HTTP timeout (tester finding: it timed out for
  // real users). Give it a proper budget; each call is short-lived, no retry.
  // JOB+POLL, like find_bugs / fix_bug / prove_fix. The work takes ~47-50s
  // measured against a real order_fuzz pattern, and Cloudflare cuts an origin
  // request at ~100s — a 2x margin, not 10x. When it is crossed the ORIGIN
  // still logs 200 while the caller sees a failure it cannot attribute, which
  // is the shape a real Cursor session reported on 2026-09-07.
  //
  // Every HTTP call here is short, so nothing is exposed to the edge timeout.
  // Server-side the same flag moves the container work off the event loop,
  // which it was blocking for the full duration of every simulation.
  body.async_job = true;
  //
  // A published client must never require a deploy to have happened. A backend
  // without async support IGNORES an unknown body field (pydantic drops extras
  // silently — verified) and answers the START call with the finished
  // simulation. startAndPoll would then look for a job_id, not find one, and
  // throw "Could not start job" — so publishing this before the deploy would
  // break every verify_behavior call in every installed IDE.
  //
  // So: start it by hand, and take whichever shape comes back. A job_id means
  // the backend is new and we poll; a body that already carries the simulation
  // means it is old and we are done.
  const start = await postJson<Record<string, unknown>>(
    "/api/mcp/verify_behavior",
    body,
  );
  const raw = (
    start.job_id
      ? await pollJob(String(start.job_id), {
          // Two sims (buggy + fixed) x every permutation and duplicate variant.
          // Returns as soon as it is done; this is only the ceiling.
          maxMs: 10 * 60_000,
        })
      : start
  ) as unknown as BackendVerifyResponse;
  const probes = (raw.probes ?? []).map((p) => {
    const buggy_status = p.buggy_response?.status;
    const fixed_status = p.fixed_response?.status;
    return {
      name: p.name,
      buggy_status,
      fixed_status,
      matched_expectation: p.expected_diff_observed ?? false,
      divergent:
        typeof buggy_status === "number" &&
        typeof fixed_status === "number" &&
        buggy_status !== fixed_status,
      verdict: p.verdict,
    };
  });
  return {
    pattern_id: raw.pattern_id,
    // Forward the server's typed next step. These clients whitelist fields, so
    // a server-side addition is invisible here unless it is named — which is
    // how find_bugs shipped for a month as "the first step of an
    // investigate->fix->prove flow" that returned no step two.
    next_actions: raw.next_actions ?? undefined,
    prove_instructions: raw.prove_instructions ?? undefined,
    mode: raw.mode,
    // Full response bodies live on the receipt; the tool returns the verdict-
    // level diff so the agent's transcript stays small.
    // An order_fuzz simulation returns NO probes — it returns an `order_fuzz`
    // block with a per-side verdict. This client whitelists fields, so that
    // block was dropped and the probe-based rule below then evaluated an empty
    // array to `confirmed: false`. Every order_fuzz pattern therefore came back
    // to the agent as "confirmed: false, probes: []" while the server held a
    // correct, measured proof.
    //
    // Measured on prod 2026-09-07, duplicate_provisioning_on_webhook_retry:
    //   server:  buggy idempotent=false max_side_effects=2
    //            fixed idempotent=true  max_side_effects=1  -> a real flip
    //   agent:   {confirmed: false, probes: []}
    //
    // Same failure as the find_bugs next_actions whitelist named above, in the
    // same file, three fields down. For this mode the SERVER owns the verdict:
    // it ran the permutations and it is the only party that saw them.
    order_fuzz: raw.order_fuzz ?? undefined,
    // Confirmed = every probe met its expectation AND the pattern actually
    // manifested a behavioral difference somewhere. A run of only sanity
    // probes (buggy == fixed everywhere) matches expectations but proves
    // nothing, so it must NOT count as a confirmation. That rule is about
    // PROBES, so it applies only where probes exist.
    confirmed: raw.order_fuzz
      ? raw.order_fuzz.confirmed === true
      : probes.length > 0 &&
        probes.every((p) => p.matched_expectation) &&
        probes.some((p) => p.divergent),
    // Which property the fuzzer actually flipped — order independence,
    // terminal safety, idempotency. Never let a receipt claim a property this
    // run did not prove.
    confirmed_by: raw.order_fuzz?.confirmed_by ?? undefined,
    disclaimer: raw.disclaimer,
    probes,
    duration_ms: raw.duration_ms,
  };
}
