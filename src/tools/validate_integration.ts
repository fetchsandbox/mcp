import { getJson, postJson, ToolError } from "../client.js";

/**
 * Point the user's OWN app at a twin, then read what it did.
 *
 * WHY THIS TOOL EXISTS, in the words of an agent that hit the gap:
 *
 *   "The catch — this didn't touch your actual app. Your real checkout
 *    endpoint, your real /api/webhooks/stripe handler, and your real email
 *    send were never called. That's still a mock, just a fancier one — it
 *    proves Stripe's API behaves like Stripe says it does, not that your
 *    integration wired to it correctly."
 *
 * Measured 2026-09-24. The agent then asked for exactly this capability —
 * "you point your app's Stripe base URL at the sandbox and give FetchSandbox a
 * reachable URL for your webhook endpoint" — and could not reach it, because
 * the endpoint shipped to prod without a tool in front of it.
 *
 * That also explains a number we had been reading as agent behaviour: across
 * 57,275 twin requests since 2026-05-09, 1.72% ran under a non-default
 * scenario. An agent declining to arm a failure on OUR canned workflow is not
 * being lazy — arming one there proves nothing about the caller's code, and it
 * was right about that.
 */
export interface ValidateIntegrationInput {
  /** Where THEIR app is reachable. The one fact we cannot derive. */
  app_base_url?: string;
  /** Providers the app integrates — ["paddle", "resend"] for a relay. */
  providers?: string[];
  /** Carry this back to continue; it makes re-validation a diff, not a restart. */
  session_id?: string;
  /** Probe ID returned by the session matrix; activate its failure scenario. */
  arm?: string;
  /** Probe ID to evaluate after exercising the app under that scenario. */
  probe?: string;
  /** Attempt ID returned by arm, required for evaluation or cancellation. */
  run_id?: string;
  /** Abort an interrupted attempt or retry failed scenario cleanup. */
  cancel?: boolean;
  suite?: "receipt_delivery_v1" | "receipt_recovery_v1" | "application_workflow_v1";
  receipt_config?: {
    webhook_url: string;
    recipient_a: string;
    recipient_b: string;
    purchase_marker: {field: "html" | "text" | "subject" | "tags"; tag_name?: string};
    observation_seconds?: number;
    app_version: string;
    source_lookup_required: boolean;
    purchase_context?: Record<string, unknown>;
  };
  execute?: boolean;
  preflight?: boolean;
  fixtures?: {id: string; steps: Record<string, unknown>[]};
  application_context?: Record<string, unknown>;
  application_config?: Record<string, unknown>;
}

const coordinationGuidance = {
  execution: {
    mode: "existing_backend_job",
    execute_returns_without_waiting_for_completion: true,
    additional_background_helper_required: false,
    instruction: "Execute once. Follow the returned status next_tool_call in this same builder agent; do not request a background helper just to monitor this run.",
  },
  owner_browser_handoff: {
    confirmation: "one_native_question",
    instruction: "If the browser is blocked, immediately offer the same run/order-verified original TEST checkout URL with livemode=false in one native owner question. Pause for its answer while the backend job continues. Record that confirmation once, retrieve the same run, and independently verify paid state. Never bypass a challenge, create a replacement checkout, retry Pay, or request confirmation again after it is recorded.",
  },
};

/** Authoring diagnostics only. Never repairs a contract or relaxes server checks. */
function applicationContractDiagnostics(config: Record<string, unknown>) {
  const errors: {path: string; code: string; message: string}[] = [];
  if (!Array.isArray(config.checks)) return errors;
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const pathCheck = (value: unknown, path: string) => {
    if (typeof value === "string" && (value.includes("?") || value.includes("#"))) {
      errors.push({path, code: "query_or_fragment_not_supported", message:
        "This HTTP contract does not accept query strings or fragments, including non-secret run IDs. Use an inspected same-origin route with the run/order ID in a path segment. For GET observations, add that protected observer route if needed; do not drop its scope filter."});
    }
  };
  config.checks.forEach((check, index) => {
    if (!object(check) || check.unsupported_reason) return;
    const prefix = `application_config.checks[${index}]`;
    for (const field of ["before", "observe"] as const) {
      if (object(check[field])) pathCheck(check[field].path, `${prefix}.${field}.path`);
    }
    if (!Array.isArray(check.actions)) return;
    check.actions.forEach((action, actionIndex) => {
      if (!object(action)) return;
      const path = `${prefix}.actions[${actionIndex}]`;
      if (!("event" in action)) { pathCheck(action.path, `${path}.path`); return; }
      if (Object.keys(action).some(key => !["event", "expect_status"].includes(key))) {
        errors.push({path, code: "signed_event_action_fields", message:
          "A signed-event action accepts only event and optional expect_status. Remove method, path, body and headers from this action; put webhook routing in application_config.event_destinations. Do not replace it with method EVENT or disable signature verification."});
      }
      const event = action.event;
      if (!object(event) || Object.keys(event).some(key => !["provider", "type", "payload", "replay_of"].includes(key))) {
        errors.push({path: `${path}.event`, code: "signed_event_fields", message:
          "event must be an object with provider/type/payload, or provider/replay_of for an exact replay. Extra signature, routing or envelope fields are not supported; preserve unsupported checks explicitly."});
      } else if (event.replay_of && (Object.keys(event).length !== 2 || !("provider" in event))) {
        errors.push({path: `${path}.event`, code: "signed_event_replay_fields", message:
          "An exact replay accepts only provider and replay_of. Do not supply a replacement type or payload."});
      }
      if (index === 0) {
        errors.push({path, code: "baseline_signed_event", message:
          "The first baseline check requires ordinary successful HTTP app actions and independently saved state, without signed events. Establish the fresh pending order in baseline, then prove signed payment and access in a later check. Preserve those purchase assertions; do not remove them to obtain a pass."});
      }
    });
  });
  return errors;
}

export const validateIntegrationTool = {
  name: "validate_integration",
  description:
    "Start with providers (and optional app_base_url), then reuse the returned session_id for application_context, fixtures and attempts. Do not include application_context in the initial session call. Inspect how the actual app or workflow executes before choosing a verification path. If the builder can run that workflow locally, bind its real provider clients to every returned twin URL and the supplied test authentication. Use the returned provider operation contracts to implement those clients; a missing canned workflow does not mean the provider lacks an API operation. The existing arm/probe path does not require a published app or webhook: select a probe from the returned matrix, call arm with session_id, send its request_headers on EVERY provider request across the session, execute the actual workflow entry point, then call probe with the same session_id and returned run_id. Independently assert saved app state in the host and report that evidence separately. Provider traffic alone remains app_verified:false; it does not establish application execution or state. Do not substitute a standalone simulation, direct twin calls or a curated workflow for the user's implementation. A public origin is required when FetchSandbox must drive or observe an HTTP application suite; the hosted setup instructions below apply to that path. " +
    "For hosted application_workflow_v1 apps, build and publish the disabled test adapter before requesting short-lived credentials. After installing the existing handoff and republishing, call preflight:true with session_id/run_id. A setup_blocked response is not a failed application test. Its next_tool_call is null: repair its exact host-side blocker first, then call resume_tool_call for the SAME run/preflight without rotating credentials. Do not poll an unchanged setup blocker. Execution has a separate deadline. Execution is already non-blocking: execute:true starts the existing backend job and returns running promptly. Use the SAME builder agent to follow status; no extra background helper or helper approval is needed. Never execute twice; retrieve status with session_id/run_id only. If the browser stops at a security challenge, immediately hand the owner the SAME run/order-verified original TEST checkout URL (livemode=false) while observation continues; never bypass the challenge, silently wait, create a replacement checkout or retry Pay. For an owner-assisted browser step, use ONE native question containing that verified URL, pause the builder for its answer while the backend job continues, and record that answer once. Do not keep working while asking for a plain chat reply that the host queues, or ask again after confirmation is recorded. Browser payments require an available browser or one explicit user action, and independently observed paid state; a click is not proof. After proof, remove only temporary settings, republish and verify disabled externally. " +
    "For every app, inspect capabilities, coverage_policy and application_actions. Review every supplied coverage dimension against inspected app behavior without waiting for the user to enumerate failure tests. Supply application_config.coverage_review with relevance, reason and linked check IDs when the builder authors the plan. Missing dimensions stay unreviewed. A dimension review is not execution proof; never claim all possible invariants are known. Prepare missing test products, prices and related records before failures: author fixtures using documented provider operations, include a final GET with an exact identity assertion, then configure the app with returned fixture IDs. The server uses the existing twin workflow runner and independently checks read-back. Fixture readiness is not app proof. Unsupported application checks must be reported explicitly, not replaced by a separate script or quickrun. " +
    "Use the returned fixture_authoring contract, not a web search for assertion syntax. Prepare fixtures before configuring any attempt. Fixture assertions are GET-only and contain select, equals (string), required:true, count:1. Use separate asserted GET steps for each additional value; do not use application all_of or where predicates in fixture assertions. Paddle selectors include the response envelope, e.g. data.id; Stripe uses id. Read the provided Paddle one-time-price example and adapt its product and amount to the app. If fixed receipt-suite transactions cannot match the app's product, price and pending order, do not execute them as app proof or a pointless rejection diagnostic. Report that compatibility gap, cancel any unexecuted mismatched attempt, then use application_workflow_v1 for supported checks while preserving untested receipt rules. " +
    "After session creation, send session_id and application_context with the original goal and inspected workflow to obtain model-proposed rules, missing observations and fixture requirements. This planning action requires sign-in. Proposals are not executed checks. Preserve all proposed rules in the coverage report, even when unsupported. If server_requirements_model_available is false or planning returns requirements_model_unavailable, inspect the app and author the candidate contract with your own model; label it builder-proposed, not a FetchSandbox model result. Never wait for the human to write routine test requirements. " +
    "For a normal HTTP app workflow with independently readable state, configure application_workflow_v1 and application_config. Declare a positive baseline first using ordinary HTTP app actions, no signed events, GET observations and required exact assertions. A pending order is a valid baseline; prove signed payment and access in a later check without removing those assertions. HTTP actions are {method,path,body?,expect_status?}; signed-event actions are ONLY {event:{provider,type,payload},expect_status?}, or {event:{provider,replay_of},expect_status?} for exact replay. Never combine event with method/path/body/headers or invent method EVENT. Webhook paths belong in event_destinations. All action, before and observe paths must omit query strings and fragments, even run_id queries: use inspected protected path-segment routes and preserve run scoping. A configuration_rejected result identifies offending field paths; repair those fields in the SAME session before another configuration call. It is not an app test result and does not request credentials. Reuse the proposed rule IDs; omitted rules remain unmeasured. Signed callback app_response contains a sanitized acknowledgement; response remains delivery metadata. Inspect response_capture_status when the body is missing, and independently read state for the verdict. Signed provider event actions use isolated secure-handoff signing secrets; bind payload identity to actual app responses and verify saved state. No browser, arbitrary auth-header or SQL execution is supported by this HTTP contract: record those gaps explicitly. Do not weaken signature or access checks to make a test pass. " +
    "Start a validation session for the user's integration. " +
    "quickrun and run_workflow execute OUR curated workflow against a " +
    "twin — green there says the provider behaves as documented, and says " +
    "nothing about whether their integration wired to it correctly. This " +
    "instead hands back a FRESH twin per provider and asks the user to point " +
    "their app at it, then reads external provider traffic. Direct agent " +
    "calls also appear there; caller identity is not established. Use it " +
    "when someone wants their integration verified before launch. Call once " +
    "with `providers`, then follow the returned `next_action`. Inspect the app " +
    "and supply a complete `receipt_config` before configuring the suite; the " +
    "application suite drives its own purchases and webhooks, so do not ask " +
    "the user to run a manual flow first. " +
    "The matrix is returned before any traffic: pass `arm` with a probe ID before exercising " +
    "the app. Send the returned request_headers on every provider request " +
    "in that attempt, then pass `probe` and `run_id` to evaluate. " +
    "Use `cancel: true` with `run_id` to abort or retry failed cleanup. " +
    "Request logs alone do not prove application state or production readiness. " +
    "For a supported payment-to-receipt integration, follow the structured " +
    "`next_action`; call `next_tool_call` only when it is non-null and its " +
    "arguments are complete. Never execute while host-side setup is pending. " +
    "Do not substitute " +
    "guide, quickrun, list_workflows, or reference probes for application " +
    "verification. Use the widest suite the server recommends. " +
    "receipt_recovery_v1 includes R1-R4 and adds checks R5-R8 for accepted-send response loss, " +
    "concurrent redelivery, source/email transient failures and delayed " +
    "redelivery. Pass suite plus " +
    "receipt_config with the app's exact webhook URL, test recipients and " +
    "observable purchase marker. FetchSandbox freezes all four receipt rules " +
    "for both same-customer and different-customer purchases. You are responsible " +
    "for completing this setup: treat the target as a disposable test app, not " +
    "the user's live production service, until its " +
    "declared suite passes. For a greenfield app, keep live billing disabled and " +
    "publish a temporary test build first to obtain its stable public origin. Use " +
    "the published webhook URL, not a private preview URL. Inspect the app and " +
    "identify the exact webhook route before suite configuration. Before requesting " +
    "or applying test secrets, send an unsigned POST to that exact URL from outside the workspace; " +
    "a 400 signature rejection is expected, while a 307/login redirect is a blocker. " +
    "Keep signature validation enabled. After the successful preflight, configure " +
    "the suite with its complete receipt_config. Apply the returned twin URLs, " +
    "X-Flow-Run-Id, and three temporary credentials only to this disposable app; " +
    "execute only after the host-side setup actions are complete. The credentials are " +
    "twin-only test values: " +
    "PADDLE_API_KEY, RESEND_API_KEY, and PADDLE_WEBHOOK_SECRET. Use the platform's " +
    "supported secret store or secret-writing tool and never use real provider " +
    "credentials or enable live billing. After every required check is held, remove " +
    "only the test secrets and twin config this run added, including from the " +
    "disposable test app's published scope. Never modify a separate live production " +
    "app or delete pre-existing, shared, " +
    "or real-provider values. Confirm the temporary names are absent, then hand the " +
    "app to its owner to configure separate development/staging credentials. If the " +
    "suite is failing or inconclusive, retain test config for repair and a fresh run. " +
    "The configure_app " +
    "response contains public twin URLs/IDs and a secret_handoff_url, never the " +
    "secret values themselves. If the host exposes no safe way for you to write " +
    "test secrets, explain that specific limitation and show the human the link " +
    "to open while signed in to the owning FetchSandbox account; they can copy " +
    "the three values directly into the platform secret store. Do not ask the " +
    "human to discover endpoints, call FetchSandbox manually, or paste secret " +
    "values into chat, project files, or logs. Wait for confirmation only when " +
    "the human must complete that secure-store action. Then call execute:true " +
    "with its run_id. FetchSandbox drives signed " +
    "events and independently observes accepted email records. Keep every " +
    "check and the observation windows in your report. Restore any temporary " +
    "host privacy setting after the test. On an inconclusive " +
    "execute result, inspect and report its `execution_diagnostics` field " +
    "directly; do not ask the human to infer a cause from the public receipt " +
    "page, which intentionally omits private proof. If you cannot configure " +
    "the app, report that blocker; reference tests cannot replace app execution. " +
    "A verified receipt suite covers only its declared rules and windows, " +
    "never all production behavior. A missing or untriggered recovery fault " +
    "stays unmeasured. This application suite requires sign-in. " +
    "Paddle checkout is a separate app-owned browser flow: if a transaction's " +
    "`checkout.url` points to `fetchsandbox.com/checkout`, returns 404, or does " +
    "not show a checkout page, do not imply FetchSandbox hosts the merchant's " +
    "payment UI. Inspect the exact URL and the Paddle Sandbox default payment " +
    "link or per-transaction override. Tell the builder to use a reachable app " +
    "checkout page that loads Paddle.js and opens the `_ptxn` transaction, or " +
    "a supported Paddle-hosted flow. Verify browser checkout/payment separately " +
    "from twin API and webhook tests; transaction creation alone is not payment proof.",
  inputSchema: {
    type: "object",
    properties: {
      providers: {
        type: "array",
        items: { type: "string" },
        description:
          "Provider slugs the app integrates, e.g. ['stripe'] or " +
          "['paddle','resend']. For provider-free HTTP workflows, omit providers and pass app_base_url.",
      },
      app_base_url: {
        type: "string",
        description:
          "App origin when FetchSandbox must drive or observe a hosted HTTP suite. " +
          "Optional for a provider-backed workflow executed by the builder through arm/probe; " +
          "that path does not require a published app or webhook.",
      },
      session_id: {
        type: "string",
        description:
          "Returned by the first call. Pass it back after their app has run " +
          "a flow to see what it did.",
      },
      arm: {
        type: "string",
        description: "Probe ID from the matrix to arm before running the app. Requires session_id.",
      },
      probe: {
        type: "string",
        description: "Probe ID from the matrix to evaluate after running the app. Requires session_id and run_id.",
      },
      run_id: {
        type: "string",
        description: "Attempt ID returned by arm or suite configuration. Required with probe, cancel, execute or preflight; prevents stale calls from consuming a newer attempt.",
      },
      cancel: {
        type: "boolean",
        description: "Abort the attempt or retry failed cleanup. Requires session_id and run_id; cannot combine with arm or probe.",
      },
      suite: {type: "string", enum: ["receipt_delivery_v1", "receipt_recovery_v1", "application_workflow_v1"],
        description: "Configure the declared application receipt suite on this session."},
      receipt_config: {
        type: "object",
        properties: {
          webhook_url: {type: "string", description: "Exact normal application webhook URL, including path."},
          recipient_a: {type: "string", description: "Expected test recipient for purchase A, fixed before execution."},
          recipient_b: {type: "string", description: "Different test recipient for the different-customer case."},
          purchase_marker: {type: "object", properties: {
            field: {type: "string", enum: ["html", "text", "subject", "tags"]},
            tag_name: {type: "string"},
          }, required: ["field"], additionalProperties: false,
          description: "Where the normal receipt includes its Paddle transaction ID; same-record recipient/marker matching is required."},
          observation_seconds: {type: "number", minimum: 0.1, maximum: 5,
            description: "Observation window after each checkpoint; default 2 seconds. Verdict covers only measured windows."},
          app_version: {type: "string", description: "Declared application build identifier; not code attestation."},
          source_lookup_required: {type: "boolean", description: "Whether the app reads the source provider during its normal webhook handler."},
          purchase_context: {type: "object", description: "Application routing custom_data, e.g. test workspace ID. Never credentials."},
        },
        required: ["webhook_url", "recipient_a", "recipient_b", "purchase_marker", "app_version", "source_lookup_required"],
        additionalProperties: false,
      },
      preflight: {type: "boolean", description: "Read-only public readiness check for a configured application_workflow_v1. Requires session_id/run_id. Checks frozen empty baseline and token enforcement without creating orders, injecting faults or rotating secrets. Retry same run after its exact setup blocker is repaired."},
      execute: {type: "boolean", description: "Drive the configured app and evaluate the frozen receipt suite. Requires session_id/run_id; configuration acknowledgment alone is not proof. Starts the existing backend job asynchronously and returns promptly; follow status in this agent without allocating a background helper."},
      fixtures: {
        type: "object", required: ["id", "steps"], additionalProperties: false,
        description: "Prepare session-owned twin data before app tests. Requires session_id. Stable id makes repeated calls replay-safe. Every step names spec, method and relative path. Use {{step1.id}} for dependencies. End with GET and an exact identity assertion. No live provider calls.",
        properties: {
          id: {type: "string", minLength: 1, maxLength: 100},
          steps: {
            type: "array", minItems: 1, maxItems: 40,
            items: {
              type: "object", required: ["spec", "method", "path"], additionalProperties: false,
              properties: {
                name: {type: "string"}, spec: {type: "string"},
                method: {type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                path: {type: "string"}, body: {type: "object"}, query_params: {type: "object"},
                expect_status: {type: "integer", minimum: 200, maximum: 299},
                assertion: {
                  type: "object", required: ["select", "equals", "required", "count"], additionalProperties: false,
                  description: "GET read-back only. Exactly four fields, e.g. {select: data.id, equals: '{{step2.id}}', required: true, count: 1} for Paddle. Use separate GET assertions for amount and currency; application all_of/where and JSON scalar predicates are not supported here.",
                  properties: {
                    select: {type: "string"}, equals: {type: "string"},
                    required: {type: "boolean", enum: [true]}, count: {type: "integer", enum: [1]},
                  },
                },
              },
            },
          },
        },
      },
      application_context: {
        type: "object", required: ["goal"], additionalProperties: false,
        description: "Bounded inspected app summary, not credentials or raw code. The existing requirements model proposes rules; it cannot issue a verdict. Requires sign-in and an existing session_id: start with providers first, then send this context in a separate call using the returned session. Separate from fixtures/execution.",
        properties: {
          goal: {type: "string"}, app_version: {type: "string"}, workflow: {type: "string"},
          entry_points: {type: "array", items: {type: "string"}}, state_store: {type: "string"},
          fixture_requirements: {type: "array", items: {type: "string"}},
        },
      },
      application_config: {
        type: "object", required: ["app_version", "disposable_test_app", "checks"], additionalProperties: false,
        description: "Frozen HTTP app drive/read-back contract: 1-30 checks, 1-20 actions per executable check, at most 300 declared actions in total, below 64 KiB. Preserve intermediate reads within these bounds; do not silently remove them. First check id=baseline must establish success. Checks require id, name, before {path,assertion}, ordinary HTTP actions [{method,path,body?,expect_status?}] or signed-event actions [{event:{provider,type,payload},expect_status?}], observe {path}, and assertion using select/equals/count/required or all_of. where and all_of must be lists of assertion objects, not field maps. equals accepts JSON strings, numbers, booleans and null; numeric/boolean literals preserve type, and null must be a present null field. Stripe event.payload is only the resource inside data.object, never a full event or a data.object wrapper: the server constructs and signs the envelope. Optional per-check observation_deadline_seconds (0-180, repeat=1 only) records bounded polling for eventual saved state; it does not drive a browser or turn a timeout into a pass. Every check first reads its declared starting-state precondition. Baseline requires count=0 on the same observed collection, with no where filter. Use {{run_id}} to scope fresh synthetic records. All paths are app-relative without query strings or fragments, including non-secret run_id queries; preserve run scoping through an inspected protected path-segment observer. Baseline permits only ordinary HTTP actions without signed events; prove signed purchase/access in later checks. Do not combine event actions with method/path/body/headers. {{step1.id}} binds a real action response to read-back. assertion.repeat (1-5) and stable_under_repeat support replay. Optional fault {provider,scenario} requires independently recorded provider refusal. Unsupported checks contain id,name,unsupported_reason only. No user-supplied credentials, auth headers or live data. require_verifier_token=true generates an owner-only temporary Bearer token through secure handoff for protected test endpoints.",
        properties: {
          app_version: {type: "string"}, disposable_test_app: {type: "boolean", enum: [true]},
          require_verifier_token: {type: "boolean"},
          coverage_review: {type: "array", maxItems: 17, description: "Applicability review against the returned coverage_policy. Missing dimensions remain unreviewed. Link relevant dimensions to declared checks, including explicitly unsupported checks. This is a proposed review, not execution proof.", items: {
            type: "object", required: ["dimension", "relevance", "reason", "rule_ids"], additionalProperties: false,
            properties: {dimension: {type: "string"}, relevance: {type: "string", enum: ["relevant", "not_applicable", "unresolved"]}, reason: {type: "string"}, rule_ids: {type: "array", items: {type: "string"}}},
          }},
          event_destinations: {type: "object", additionalProperties: {type: "string"}, description: "Session-provider to same-origin webhook path without query/fragment. Requires require_verifier_token=true and the isolated FETCHSANDBOX_<PROVIDER>_WEBHOOK_SECRET from secure handoff. Complete signed action shape: {event:{provider,type,payload},expect_status:200}; exact replay: {event:{provider,replay_of:'{{step2.event_id}}'},expect_status:200}. No method/path/body/headers on signed actions. Baseline uses ordinary HTTP actions; signed events belong in later checks. Existing signature checks must remain enabled."},
          observation_seconds: {type: "number", minimum: 0.1, maximum: 5},
          checks: {type: "array", minItems: 1, maxItems: 30, items: {type: "object"}},
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export async function runValidateIntegration(
  input: ValidateIntegrationInput,
): Promise<unknown> {
  const hasSession = Boolean(input.session_id && input.session_id.trim());
  const hasProviders = Array.isArray(input.providers) && input.providers.length > 0;
  if (input.suite && !["receipt_delivery_v1", "receipt_recovery_v1", "application_workflow_v1"].includes(input.suite)) {
    throw new ToolError("Unknown application verification suite.");
  }
  if (input.application_context && !hasSession) {
    throw new ToolError("`application_context` requires an existing `session_id`. First call validate_integration with `providers` (and optional `app_base_url`) without application_context; then send the same application_context with the returned session_id in a separate call. Planning requires sign-in.");
  }
  if (input.fixtures && !hasSession) {
    throw new ToolError("`fixtures` requires an existing `session_id`. Start a validation session with providers, then prepare fixtures in that same session before configuring an attempt.");
  }
  if ((input.execute || input.preflight) && !hasSession) {
    throw new ToolError("`execute` and `preflight` require the existing `session_id` and the `run_id` returned by suite configuration. Complete the returned setup actions before execution.");
  }
  if ((input.arm || input.probe || input.cancel) && !hasSession) {
    throw new ToolError("Pass `session_id` when arming or evaluating a probe.");
  }
  if ([input.arm, input.probe, input.cancel, input.suite, input.execute, input.preflight, input.fixtures, input.application_context].filter(Boolean).length > 1) {
    throw new ToolError("Configure, execute, arm, evaluate and cancel are separate calls.");
  }
  if (input.receipt_config && !input.suite) throw new ToolError("receipt_config requires suite.");
  if (input.application_config && input.suite !== "application_workflow_v1") throw new ToolError("application_config requires application_workflow_v1.");
  if ((input.execute || input.preflight) && !input.run_id?.trim()) {
    throw new ToolError("Pass the `run_id` returned by suite configuration with the same session_id for execute or preflight.");
  }
  if ((input.probe || input.cancel) && !input.run_id?.trim()) {
    throw new ToolError("Pass the run_id returned by arm to evaluate or cancel.");
  }
  if (input.run_id && (!hasSession || input.arm || input.suite || input.fixtures || input.application_context)) {
    throw new ToolError("run_id requires session_id; status retrieval must use the same session.");
  }
  if (!hasSession && !hasProviders && !input.app_base_url) {
    throw new ToolError(
      "Pass `providers` (e.g. ['stripe']) to start a validation session, or " +
      "`session_id` from a previous call to continue one.",
    );
  }
  if (input.application_config) {
    const errors = applicationContractDiagnostics(input.application_config);
    if (errors.length) return {
      session_id: input.session_id, status: "configuration_rejected", step: "configure_application",
      app_verified: false, configuration_accepted: false, next_action: "repair_application_contract",
      next_tool_call: null, validation_errors: errors,
      message_for_user: "This configuration was not sent to the backend. No application action ran and this call created no attempt or credentials. Repair the indicated fields in the same session; retain all intended checks and safety guards.",
    };
  }
  const result = await postJson<Record<string, unknown>>("/api/mcp/validate_integration", {
    providers: input.providers ?? [],
    app_base_url: input.app_base_url ?? "",
    session_id: input.session_id ?? null,
    arm: input.arm ?? null,
    probe: input.probe ?? null,
    run_id: input.run_id ?? null,
    cancel: input.cancel ?? false,
    suite: input.suite ?? null,
    receipt_config: input.receipt_config ?? null,
    execute: input.execute ?? false,
    preflight: input.preflight ?? false,
    async_job: input.execute ?? false,
    fixtures: input.fixtures ?? null,
    application_context: input.application_context ?? null,
    application_config: input.application_config ?? null,
  });
  // A short backend job poll does not make the enclosing MCP HTTP request
  // short. Recovery suites outlive its 90-second deadline. Return readiness
  // promptly and let the caller retrieve this same session, never re-execute.
  let completed = result.job_id
    ? await getJson<Record<string, unknown>>(`/api/mcp/jobs/${String(result.job_id)}`)
    : result;
  if (completed.status === "running" && hasSession && !input.execute && !input.arm && !input.probe && !input.cancel && !input.suite) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    completed = await postJson<Record<string, unknown>>("/api/mcp/validate_integration", {session_id: input.session_id, ...(input.run_id ? {run_id: input.run_id} : {})});
  }
  if (completed.status === "running" && hasSession) {
    return {...completed, coordination_guidance: coordinationGuidance, session_id: input.session_id, run_id: input.run_id ?? completed.run_id,
      step: "executing", app_verified: false, next_action: "wait_then_retrieve_same_session",
      retry_after_seconds: 10,
      next_tool_call: {tool: "validate_integration", arguments: {session_id: input.session_id, ...(input.run_id ? {run_id: input.run_id} : {})}},
      message_for_user: "The application suite is running. Wait at least 10 seconds, then retrieve this same session with session_id only. Do not send execute again, cancel, replace its credentials, or start another run while it is running."};
  }
  // Keep the complete archive in the owned receipt. Six cumulative snapshots
  // can otherwise exhaust the hosted caller's context before it reads a verdict.
  if (completed && typeof completed === "object" &&
      "suite" in completed && ["receipt_delivery_v1", "receipt_recovery_v1", "application_workflow_v1"].includes(String(completed.suite)) && "verdict" in completed) {
    const {manifest: _manifest, evidence: _evidence, ...summary} = completed as Record<string, unknown>;
    if (Array.isArray(summary.checks)) {
      summary.checks = summary.checks.map(check => {
        if (!check || typeof check !== "object") return check;
        const row = check as Record<string, unknown>;
        const detail = typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "");
        return {...row, detail: detail.slice(0, 1000), ...(detail.length > 1000 ? {detail_truncated: true} : {})};
      });
    }
    if (summary.execution_diagnostics && typeof summary.execution_diagnostics === "object") {
      const diagnostic = summary.execution_diagnostics as Record<string, unknown>;
      const trace = Array.isArray(diagnostic.trace) ? diagnostic.trace : [];
      const selected = trace.filter(row => row && typeof row === "object" &&
        (row.kind === "transport_event" || (row.kind === "app_webhook" && row.http_status >= 400) ||
         (row.kind === "provider_request" && row.transport_mode === "until_matching_retry"))).slice(0, 32);
      const allowed = ["kind", "at", "phase", "case", "stage", "role", "request_id", "retry_request_id",
        "http_status", "method", "path", "operation", "transport_state", "transport_mode", "release_reason",
        "delay_ms", "client_disconnected_at", "retry_observed_at"];
      summary.execution_diagnostics = {...diagnostic,
        trace: selected.map(row => Object.fromEntries(allowed.filter(key => key in row).map(key => [key, row[key]]))),
        trace_truncated: Boolean(diagnostic.trace_truncated) || selected.length < trace.length,
        trace_omitted_from_tool: trace.length - selected.length,
        trace_access: "The stored receipt retains the full sanitized timeline and expandable request/response fields."};
    }
    return {...summary, coordination_guidance: coordinationGuidance, evidence_access: "Full recorded evidence is available to the receipt owner through the stored receipt."};
  }
  return {...completed, coordination_guidance: coordinationGuidance};
}
