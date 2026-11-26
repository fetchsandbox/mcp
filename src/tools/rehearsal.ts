/** Guided entry points over the existing validation session and job owners.
 * No client-side session, verdict, contract store, retry loop or second engine.
 * The advanced validate_integration surface remains the contract authoring API.
 */
import { ToolError } from "../client.js";
import { runValidateIntegration } from "./validate_integration.js";
import { runGetJob } from "./jobs.js";

const identity = { type: "string", minLength: 1, maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$", description: "Exact identifier returned by FetchSandbox. Never invent or infer it." } as const;
const attemptProperties = { session_id: identity, run_id: identity };

export const planRehearsalTool = {
  name: "plan_rehearsal", title: "Plan a workflow rehearsal",
  description: "Start here to test an application's integration behavior. Pass the user's goal in ordinary language. Inspect the authorized project first and supply discovered application facts when available; if they are missing this returns inspection guidance without creating an environment. Ask the user only for unavailable access or unresolved business policy. Proposes scenarios and required observations through the existing planner; it never runs the app or proves a pass. Retain the returned session/job IDs. Review proposed rules, business questions and missing observations before configuring the executable contract with validate_integration. Do not substitute a reference workflow for the app.",
  inputSchema: { type: "object", additionalProperties: false, required: ["goal"], properties: {
    goal: {type: "string", minLength: 1, maxLength: 8000, description: "The user's workflow goal or testing request, unchanged."},
    session_id: identity,
    application: { type: "object", additionalProperties: false, description: "Facts discovered by the agent from the authorized app, not technical questions for the user. No credentials or raw source.", properties: {
      providers: {type: "array", maxItems: 20, uniqueItems: true, items: {type: "string", minLength: 1}, description: "Catalog provider identifiers established from the app and catalog, not guessed. Explicit [] with an origin selects a provider-free HTTP app."},
      origin: {type: "string", description: "Published disposable test-app origin or app_base_url returned by manage_tunnel. Never use a production app by assumption."},
      version: {type: "string"}, workflow: {type: "string"},
      entry_points: {type: "array", items: {type: "string"}},
      state_store: {type: "string"}, fixture_requirements: {type: "array", items: {type: "string"}},
    }},
  }},
} as const;

export const runRehearsalTool = {
  name: "run_rehearsal", title: "Run the reviewed rehearsal",
  description: "Execute ONCE the existing frozen, reviewed test-app contract. Use only the session_id and run_id returned by validate_integration configuration, after protected test credentials and app setup are installed. The existing engine checks readiness, drives scenarios and owns the verdict. A returned job or running state is not success. If submission is uncertain do not retry; retrieve this same attempt. This does not configure a contract or authorize production writes.",
  inputSchema: {type: "object", additionalProperties: false, required: ["session_id", "run_id"], properties: attemptProperties},
} as const;

export const getRehearsalTool = {
  name: "get_rehearsal", title: "Get rehearsal progress or results",
  description: "Read the SAME rehearsal attempt or planning/execution job without starting work. Supply either its returned job_id, OR both session_id and run_id. Preserve failed, blocked and not-measured outcomes and the receipt. A native restart checkpoint requires an actual app process restart; it does not authorize another execution. A proposed plan or HTTP success is not app verification.",
  inputSchema: {type: "object", additionalProperties: false, properties: {...attemptProperties, job_id: identity},
    oneOf: [{required: ["job_id"], not: {anyOf: [{required: ["session_id"]}, {required: ["run_id"]}]}},
      {required: ["session_id", "run_id"], not: {required: ["job_id"]}}]},
} as const;

export const stopRehearsalTool = {
  name: "stop_rehearsal", title: "Stop a rehearsal attempt",
  description: "Request cancellation and scenario cleanup for the exact returned session_id/run_id. Preserve the recorded result, uncertainty and cleanup outcome. Stopping does not undo external effects already performed or turn an interrupted test into a pass. Never cancel a newer attempt to clean up an older one.",
  inputSchema: {type: "object", additionalProperties: false, required: ["session_id", "run_id"], properties: attemptProperties},
} as const;

export const rehearsalTools = [planRehearsalTool, runRehearsalTool, getRehearsalTool, stopRehearsalTool];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new ToolError(`Use the exact ${name} returned by FetchSandbox. Retrieve the prior result; do not invent an identifier.`);
  }
  return value;
}
function knownFields(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some(key => !fields.includes(key))) throw new ToolError("Unexpected rehearsal input. Use the advertised fields; advanced configuration belongs to validate_integration.");
}

/** Translate only read continuations. Never turn setup, execute or cancel into
 * another action, and never rewrite verdicts, evidence or attempt identities. */
function guidedContinuation(result: unknown): unknown {
  if (!record(result) || !record(result.next_tool_call)) return result;
  const call = result.next_tool_call;
  const args = call.arguments;
  if (!record(args)) return result;
  const name = call.tool ?? call.name;
  if (name === "get_job" && Object.keys(args).length === 1 && typeof args.job_id === "string") {
    return {...result, next_tool_call: {tool: "get_rehearsal", arguments: {job_id: args.job_id}}};
  }
  if (name === "validate_integration" && Object.keys(args).length === 2 &&
      typeof args.session_id === "string" && typeof args.run_id === "string") {
    return {...result, next_tool_call: {tool: "get_rehearsal", arguments: {session_id: args.session_id, run_id: args.run_id}}};
  }
  return result;
}

export async function runRehearsalAction(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === planRehearsalTool.name) {
    knownFields(input, ["goal", "session_id", "application"]);
    if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 8000) throw new ToolError("Describe the workflow goal in 1-8000 characters. No credentials or customer data.");
    if (input.application !== undefined && !record(input.application)) throw new ToolError("application must contain inspected app facts.");
    const app = (input.application ?? {}) as Record<string, unknown>;
    knownFields(app, ["providers", "origin", "version", "workflow", "entry_points", "state_store", "fixture_requirements"]);
    for (const key of ["providers", "entry_points", "fixture_requirements"]) {
      if (app[key] !== undefined && (!Array.isArray(app[key]) || (app[key] as unknown[]).some(x => typeof x !== "string" || !x.trim()))) throw new ToolError(`${key} must be an array of inspected nonempty strings.`);
    }
    for (const key of ["origin", "version", "workflow", "state_store"]) {
      if (app[key] !== undefined && (typeof app[key] !== "string" || !(app[key] as string).trim())) throw new ToolError(`${key} must be an inspected nonempty string.`);
    }
    if (Array.isArray(app.providers) && (app.providers.length > 20 || new Set(app.providers).size !== app.providers.length)) throw new ToolError("providers must contain at most 20 distinct catalog identifiers.");
    let sessionId = input.session_id === undefined ? undefined : exactId(input.session_id, "session_id");
    // No scan of the plugin's own cwd and no implicit access to home/other projects.
    if (!sessionId && (!Array.isArray(app.providers) || (!app.providers.length && !app.origin))) return {
      stage: "inspect_project", app_verified: false, environment_created: false,
      message_for_user: "I need the workflow's integration and saved-state details before proposing its rehearsal. No tests have run.",
      agent_next_step: "Inspect the authorized project for providers, actual entry points, saved-state observations and app version. Resolve provider names through list_specs. For a local app use its actual running port with manage_tunnel; for a hosted app use its disposable published origin. Call plan_rehearsal with the same goal and discovered application facts. Do not ask the user for internal IDs, JSON assertions or routine failure scenarios. If no project is accessible, ask for its project/workflow reference, never credentials.",
    };
    // Bound before any environment creation, matching the existing planner's limit.
    const context = {goal: input.goal, ...(app.version ? {app_version: app.version} : {}),
      ...Object.fromEntries(["workflow", "entry_points", "state_store", "fixture_requirements"].filter(k => app[k] !== undefined).map(k => [k, app[k]]))};
    if (Buffer.byteLength(JSON.stringify(context)) > 16384) throw new ToolError("The inspected app summary exceeds 16 KiB. Send bounded facts, not raw source.");
    if (sessionId && (app.origin !== undefined || app.providers !== undefined)) throw new ToolError("A resumed rehearsal keeps its original app and providers. Send only the existing session_id and planning facts; start a fresh session to change its target.");
    if (!sessionId) {
      const created = await runValidateIntegration({providers: app.providers as string[], app_base_url: app.origin as string | undefined,
        environment_scope: "owner", single_submission: true});
      if (!record(created) || typeof created.session_id !== "string") throw new ToolError("The connection response did not include a session identity. Do not automatically create another environment; report the unconfirmed connection.");
      sessionId = exactId(created.session_id, "session_id");
      // Legacy session handovers can include simulated provider keys. The
      // guided path needs only safe guidance here, never credential values.
      const guidance = Object.fromEntries(["coverage_policy", "available_suites", "application_guidance", "application_setup_policy"]
        .filter(key => created[key] !== undefined).map(key => [key, created[key]]));
      return {...guidance, session_id: sessionId, rehearsal_stage: "connected", app_verified: false,
        message_for_user: "The rehearsal environment is selected. Next I will propose scenarios from the workflow goal and inspected app. No application tests have run.",
        next_tool_call: {tool: "plan_rehearsal", arguments: {goal: input.goal, session_id: sessionId,
          application: Object.fromEntries(Object.entries(app).filter(([key]) => key !== "origin" && key !== "providers"))}},
      };
    }
    try {
      const result = guidedContinuation(await runValidateIntegration({session_id: sessionId, application_context: context}));
      return record(result) ? {...result, session_id: sessionId, rehearsal_stage: "planning", app_verified: false,
        review_instruction: "Present a short ordinary-language summary of the goal, critical proposed scenarios and expected saved outcomes first. Ask one blocking business-policy question at a time, only after inspecting the app for discoverable facts; do not paste the whole proposal or make the user design the tests. Keep the full rule list, coverage review, unresolved policy and missing observations available for detail. Summarizing the display must never drop requirements from the frozen contract or hide failed/unmeasured outcomes. A proposal has not run. Use this same session with validate_integration to prepare fixtures and freeze the executable contract; then review the target, scope and observation window before run_rehearsal."} : result;
    } catch (error) {
      // Preserve the allocated identity even when planning failed, so a caller
      // can repair in place instead of minting another environment on retry.
      if (error instanceof ToolError && error.status !== 401) return {session_id: sessionId, rehearsal_stage: "planning_blocked", app_verified: false,
        message_for_user: "The rehearsal plan could not be retrieved. No application tests were started by this call. Keep this session and inspect its planning failure before continuing.",
        planning_error: error.message, automatic_retry: false};
      throw error;
    }
  }
  if (name === getRehearsalTool.name) {
    knownFields(input, ["session_id", "run_id", "job_id"]);
    if (input.job_id !== undefined) {
      if (input.session_id !== undefined || input.run_id !== undefined) throw new ToolError("Retrieve either the returned job_id or the exact session_id/run_id pair, not both.");
      return guidedContinuation(await runGetJob(exactId(input.job_id, "job_id")));
    }
  } else if (name !== runRehearsalTool.name && name !== stopRehearsalTool.name) {
    throw new ToolError("Unknown rehearsal action.");
  } else knownFields(input, ["session_id", "run_id"]);
  const ids = {session_id: exactId(input.session_id, "session_id"), run_id: exactId(input.run_id, "run_id")};
  return guidedContinuation(await runValidateIntegration({...ids, single_submission: true,
    ...(name === runRehearsalTool.name ? {execute: true} : {}),
    ...(name === stopRehearsalTool.name ? {cancel: true} : {})}));
}
