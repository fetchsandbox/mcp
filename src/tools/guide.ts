import { postJson } from "../client.js";
import { scanRepoSignals } from "./repo_signals.js";

/**
 * Guided integration router — Phase 1.
 *
 * Maps a developer's free-form intent (e.g. "test my stripe integration"
 * or "help me set up Paddle subscriptions") to a concrete spec + workflow
 * + optional failure scenario. Used when the user doesn't name an exact
 * workflow but wants the right Tier-1 default for their goal.
 *
 * Phase 1 is routing-only — returns the resolved triple without running
 * the workflow. Sessions, branching, evidence canvas come in Phase 2+
 * (see docs/guided-integration-experience-2026-05-20.md).
 *
 * Calls POST /api/mcp/route on the backend. The backend reads the
 * spec configs deterministically — no LLM in the routing path, so demos
 * are reproducible.
 */

export interface GuideInput {
  intent: string;
  /** Repo signals. Filled in automatically from the project the MCP server is
   *  running in; a caller may override to force the disambiguation. */
  context?: Record<string, unknown>;
  hints?: {
    spec?: string;
    workflow?: string;
    scenario?: string;
  };
}

export interface GuideResponse {
  spec: string | null;
  workflow: string | null;
  scenario: string | null;
  confidence: number;
  reasoning: string;
  matched_signals: string[];
  /**
   * Phase 1.5: when the routed spec has a brain.yaml (currently stripe
   * only — Tier-1 specs will be backfilled), the first discovery
   * question is included so the LLM client can ask the dev WITHOUT a
   * second router round-trip. Shape mirrors the brain.yaml schema:
   *   { id, question, options: [{value, label, implies?}], default? }
   * or for tiered questions:
   *   { id, question, tiers: [{label, scenarios}], default_tier? }
   * Null when no brain exists for the spec.
   */
  next_question?: Record<string, unknown> | null;
}

export const guideTool = {
  name: "guide",
  description:
    "ROUTE a symptom to the provider behaviour that explains it. Use this when " +
    "the user names a provider or a domain (payments, email, auth, SMS, " +
    "subscriptions) and you need to know what that provider ACTUALLY does — " +
    "not what its docs say, and not what can be inferred from reading the " +
    "integration code. " +
    "Reading the code tells you what your app does with a field. It cannot " +
    "tell you what the field MEANS at the provider — whether a line item is a " +
    "seat count, whether a 200 body carries ok:false, whether an event can " +
    "arrive out of order. That is the class of bug this routes. " +
    "Returns {spec, workflow, scenario, confidence, reasoning} plus " +
    "`next_actions`: a typed list of what to call next, with arguments " +
    "pre-filled. Follow it rather than improvising the next step.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "The developer's free-form prompt as they typed it. Don't " +
          "pre-process or shorten — the router benefits from the full " +
          "phrasing (capture timing, geo cues, failure mode language).",
      },
      hints: {
        type: "object",
        description:
          "Optional caller-supplied overrides. Each field short-circuits " +
          "the corresponding detection step.",
        properties: {
          spec: { type: "string", description: "Force a specific spec slug." },
          workflow: { type: "string", description: "Force a specific workflow_id." },
          scenario: { type: "string", description: "Force a specific failure scenario name." },
        },
      },
    },
    required: ["intent"],
  },
};

export async function runGuide(input: GuideInput): Promise<GuideResponse> {
  // SEND WHAT THE REPO ACTUALLY INTEGRATES. The router has a `context` field
  // for exactly this — "repo signals (dependencies / detected_specs / imports)
  // so the router can disambiguate an ambiguous symptom by the provider the
  // repo actually integrates — the funnel intersect, a fact rather than a
  // guess" — and guide never sent it. coach did; guide, the tool an agent is
  // told to start with, did not.
  //
  // Measured 2026-09-07 against a Paddle + Resend app, on a symptom naming
  // neither provider: guide returned spec "stripe", workflow "accept_payment",
  // confidence 0.95. A confident route to the wrong provider is worse than no
  // route — everything downstream inherits it.
  //
  // The scan reads the manifest in the MCP server's own cwd, which IS the
  // user's project. Best-effort: a repo it cannot read sends nothing and the
  // router behaves exactly as before.
  const body: Record<string, unknown> = { ...input };
  try {
    const sig = scanRepoSignals();
    const ctx: Record<string, unknown> = {};
    if (sig.detected_specs?.length) ctx.detected_specs = sig.detected_specs;
    // code_probe is the tie-breaker the scanner computes when several providers
    // survive: whose handler the repo actually implements, not merely imports.
    if (sig.code_probe) ctx.code_probe = sig.code_probe;
    if (Object.keys(ctx).length) {
      // A caller-supplied context wins — an explicit hint is not a guess.
      body.context = { ...ctx, ...(input.context as object ?? {}) };
    }
  } catch {
    /* a repo we cannot read is not an error; route without the signal */
  }
  return postJson<GuideResponse>("/api/mcp/route", body);
}
