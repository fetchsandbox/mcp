/**
 * The failure-injection tools. This is the product, exposed.
 *
 * FetchSandbox's claim is not "we mock your API" — it is "we break your
 * integration on purpose and tell you whether the code survived". Until now an
 * agent could not do that. `quickrun`, `run_workflow` and `prove_fix` each
 * accept a `scenario` argument, but nothing LISTS the scenarios and nothing
 * ARMS one on a sandbox the agent already has. The parameter descriptions
 * named two examples in prose ("e.g. webhook_retries, payment_declined") while
 * paddle alone ships ten, so an agent could only use a failure it happened to
 * guess.
 *
 * That gap mattered most for exactly the audience we are building for.
 * Measured 2026-09-20 from 47 r/lovable posts, these are real titles:
 *
 *   "If your Lovable app works, run these failure tests before taking payments"
 *   "Before adding another Lovable feature, break one important action on purpose"
 *   "6 things that broke when my Lovable apps got their first real users"
 *
 * Those builders are already doing this by hand. `list_scenarios` +
 * `set_scenario` is the difference between "the agent can run our demos" and
 * "the agent can break the thing it just built, deliberately, and watch."
 */
import { getJson, postJson, ToolError } from "../client.js";

// ── list_scenarios ──────────────────────────────────────────────────────────

export interface ListScenariosInput {
  sandbox_id: string;
}

interface BackendSandbox {
  id: string;
  slug?: string;
  active_scenario?: string;
  scenarios?: Array<{ name?: string; description?: string } | string>;
}

export interface ListScenariosResponse {
  sandbox_id: string;
  active_scenario: string;
  scenarios: Array<{ name: string; description: string }>;
}

export const listScenariosTool = {
  name: "list_scenarios",
  description:
    "List the FAILURE SCENARIOS this sandbox can inject on demand — the " +
    "specific ways the real provider misbehaves in production. Call this " +
    "BEFORE claiming an integration works. A checkout that passes on the " +
    "happy path tells you almost nothing; the bugs that reach customers are " +
    "declined cards, webhooks delivered twice or out of order, expired " +
    "tokens, rate limits and slow networks. " +
    "Typical names: payment_declined, insufficient_funds, webhook_retries, " +
    "flaky_webhooks, replayed_old_signed_event, signed_event_with_mutated_body, " +
    "auth_failure, rate_limited, slow_network — but they differ per provider, " +
    "which is why you list them instead of guessing. " +
    "Returns each scenario's name and what it does. Arm one with set_scenario, " +
    "then re-run the same request and check the app still behaves correctly.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: {
        type: "string",
        description:
          "The sandbox_id returned by quickrun, run_workflow or import_spec.",
      },
    },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
} as const;

export async function runListScenarios(
  input: ListScenariosInput,
): Promise<ListScenariosResponse> {
  if (!input.sandbox_id) throw new ToolError("sandbox_id is required.");
  const sb = await getJson<BackendSandbox>(
    `/api/sandboxes/${encodeURIComponent(input.sandbox_id)}`,
  );
  const scenarios = (sb.scenarios || []).map((s) =>
    typeof s === "string"
      ? { name: s, description: "" }
      : { name: s.name || "", description: s.description || "" },
  ).filter((s) => s.name);
  return {
    sandbox_id: input.sandbox_id,
    active_scenario: sb.active_scenario || "default",
    scenarios,
  };
}

// ── set_scenario ────────────────────────────────────────────────────────────

export interface SetScenarioInput {
  sandbox_id: string;
  scenario: string;
}

export interface SetScenarioResponse {
  sandbox_id: string;
  active_scenario: string;
  next_step: string;
}

export const setScenarioTool = {
  name: "set_scenario",
  description:
    "ARM a failure scenario on a sandbox, so the next requests hit the " +
    "provider misbehaving instead of the happy path. This is how you find out " +
    "whether the integration you just wrote actually survives production. " +
    "Use it like this: run the flow once on 'default' and confirm it works, " +
    "call set_scenario with a failure from list_scenarios, run the SAME flow " +
    "again, then check the end state is still correct — not that the call " +
    "merely returned. A declined payment must not produce a confirmed order; " +
    "a webhook delivered twice must not charge twice or send two emails. " +
    "Set scenario to 'default' to return the sandbox to normal. " +
    "The scenario stays armed until you change it, and it affects every " +
    "caller of that sandbox — so put it back when you are done.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: {
        type: "string",
        description: "The sandbox to arm. From quickrun, run_workflow or import_spec.",
      },
      scenario: {
        type: "string",
        description:
          "A scenario name from list_scenarios, or 'default' to restore " +
          "normal behaviour. Guessing a name that does not exist fails — list first.",
      },
    },
    required: ["sandbox_id", "scenario"],
    additionalProperties: false,
  },
} as const;

export async function runSetScenario(
  input: SetScenarioInput,
): Promise<SetScenarioResponse> {
  if (!input.sandbox_id) throw new ToolError("sandbox_id is required.");
  if (!input.scenario) throw new ToolError("scenario is required.");

  const res = await postJson<{ status?: string; active_scenario?: string }>(
    `/api/sandboxes/${encodeURIComponent(input.sandbox_id)}/scenario`,
    { scenario: input.scenario },
  );
  const active = res.active_scenario || input.scenario;
  return {
    sandbox_id: input.sandbox_id,
    active_scenario: active,
    // The instruction matters as much as the result. An agent that arms a
    // failure and then only checks the HTTP status has learned nothing: the
    // point is whether the app's END STATE is still correct.
    next_step:
      active === "default"
        ? "Sandbox restored to normal behaviour."
        : `'${active}' is armed. Re-run the same flow now, then assert the END ` +
          `STATE — not just the response. Check the order/subscription/email ` +
          `did NOT proceed as if nothing went wrong. Call set_scenario with ` +
          `'default' when finished.`,
  };
}
