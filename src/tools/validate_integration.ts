import { postJson, ToolError } from "../client.js";
import { pollJob } from "./jobs.js";

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
  suite?: "receipt_delivery_v1" | "receipt_recovery_v1";
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
}

export const validateIntegrationTool = {
  name: "validate_integration",
  description:
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
          "['paddle','resend']. Required to start a session.",
      },
      app_base_url: {
        type: "string",
        description:
          "Where their app is deployed, if known. Recorded so a later step " +
          "can deliver webhooks to it.",
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
        description: "Attempt ID returned by arm. Required with probe or cancel; prevents stale calls from consuming a newer attempt.",
      },
      cancel: {
        type: "boolean",
        description: "Abort the attempt or retry failed cleanup. Requires session_id and run_id; cannot combine with arm or probe.",
      },
      suite: {type: "string", enum: ["receipt_delivery_v1", "receipt_recovery_v1"],
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
      execute: {type: "boolean", description: "Drive the configured app and evaluate the frozen receipt suite. Requires session_id/run_id; configuration acknowledgment alone is not proof."},
    },
    additionalProperties: false,
  },
} as const;

export async function runValidateIntegration(
  input: ValidateIntegrationInput,
): Promise<unknown> {
  const hasSession = Boolean(input.session_id && input.session_id.trim());
  const hasProviders = Array.isArray(input.providers) && input.providers.length > 0;
  if (input.suite && !["receipt_delivery_v1", "receipt_recovery_v1"].includes(input.suite)) {
    throw new ToolError("Unknown application verification suite.");
  }
  if ((input.arm || input.probe || input.cancel || input.execute) && !hasSession) {
    throw new ToolError("Pass `session_id` when arming or evaluating a probe.");
  }
  if ([input.arm, input.probe, input.cancel, input.suite, input.execute].filter(Boolean).length > 1) {
    throw new ToolError("Configure, execute, arm, evaluate and cancel are separate calls.");
  }
  if (input.receipt_config && !input.suite) throw new ToolError("receipt_config requires suite.");
  if ((input.probe || input.cancel || input.execute) && !input.run_id?.trim()) {
    throw new ToolError("Pass the run_id returned by arm to evaluate or cancel.");
  }
  if (input.run_id && !input.probe && !input.cancel && !input.execute) {
    throw new ToolError("run_id is only accepted with probe, cancel or execute.");
  }
  if (!hasSession && !hasProviders) {
    throw new ToolError(
      "Pass `providers` (e.g. ['stripe']) to start a validation session, or " +
      "`session_id` from a previous call to continue one.",
    );
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
    async_job: input.execute ?? false,
  });
  const completed = result.job_id
    ? await pollJob(String(result.job_id), {maxMs: 5 * 60_000})
    : result;
  // Keep the complete archive in the owned receipt. Six cumulative snapshots
  // can otherwise exhaust the hosted caller's context before it reads a verdict.
  if (completed && typeof completed === "object" &&
      "suite" in completed && ["receipt_delivery_v1", "receipt_recovery_v1"].includes(String(completed.suite)) && "verdict" in completed) {
    const {manifest: _manifest, evidence: _evidence, ...summary} = completed as Record<string, unknown>;
    return {...summary, evidence_access: "Full recorded evidence is available to the receipt owner through the stored receipt."};
  }
  return completed;
}
