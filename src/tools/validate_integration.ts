import { postJson, ToolError } from "../client.js";

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
}

export const validateIntegrationTool = {
  name: "validate_integration",
  description:
    "Prove the USER'S OWN code works against a provider, not that our twin " +
    "does. quickrun and run_workflow execute OUR curated workflow against a " +
    "twin — green there says the provider behaves as documented, and says " +
    "nothing about whether their integration wired to it correctly. This " +
    "instead hands back a FRESH twin per provider and asks the user to point " +
    "their app at it, then reads our own request log to report what THEIR code " +
    "actually called. Use it when someone wants their integration verified " +
    "before launch, or when you have just run a happy path and need to say " +
    "what it did and did not prove. Call once with `providers` to start, then " +
    "again with the returned `session_id` after their app has run a flow.",
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
    },
    additionalProperties: false,
  },
} as const;

export async function runValidateIntegration(
  input: ValidateIntegrationInput,
): Promise<unknown> {
  const hasSession = Boolean(input.session_id && input.session_id.trim());
  const hasProviders = Array.isArray(input.providers) && input.providers.length > 0;
  if (!hasSession && !hasProviders) {
    throw new ToolError(
      "Pass `providers` (e.g. ['stripe']) to start a validation session, or " +
      "`session_id` from a previous call to continue one.",
    );
  }
  return postJson("/api/mcp/validate_integration", {
    providers: input.providers ?? [],
    app_base_url: input.app_base_url ?? "",
    session_id: input.session_id ?? null,
  });
}
