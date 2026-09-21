/**
 * The sign-in handshake, run from inside a tool call.
 *
 * The whole design constraint is that this process cannot talk to the human.
 * It can only RETURN something the agent will show them. So:
 *
 *   1. ask the backend for a code
 *   2. return a message containing the URL and the code
 *   3. the agent shows it; the human signs in on the website
 *   4. poll until approved, write the key, carry on
 *
 * Step 4 blocks the tool call. That is intentional and it is why the poll has
 * a hard ceiling: an agent left waiting forever is worse than a clear failure,
 * and the human can always re-run the tool to start again.
 */
import { buildHeaders, getBaseUrl, ToolError } from "./client.js";
import { installId, readCredentials, writeCredentials, type Credentials } from "./auth.js";
import { detectIde } from "./session.js";
import { isHosted } from "./request_context.js";

// Only ever used on a RETRY, when the human has already been shown the code and
// is mid-sign-in. Long enough to cover a browser round trip, short enough that
// an agent is never left hanging on someone who walked away.
const GRACE_POLL_MS = 45_000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    // Same headers as every other call: the audit trail ties a sign-in to the
    // install and the editor it came from, which is the whole point of it.
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    /* an empty or non-JSON body is handled by the caller via status */
  }
  return { status: res.status, json: json as T };
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const { status, json } = await post<DeviceCodeResponse>("/api/auth/device/code", {
    client_name: detectIde(),
    install_id: installId(),
  });
  if (status !== 200 || !json?.user_code) {
    throw new ToolError("Could not start sign-in. Check your connection and try again.", status);
  }
  return json;
}

/** Human-facing instructions. This is what the agent shows in the IDE. */
export function signInMessage(d: DeviceCodeResponse): string {
  const url = `${d.verification_uri}?code=${encodeURIComponent(d.user_code)}`;
  return [
    "FetchSandbox needs a free account before it can run this.",
    "",
    `  1. Open  ${url}`,
    `  2. Sign in — no password, we email you a link`,
    "",
    `Your code is ${d.user_code}. It expires in ${Math.round(d.expires_in / 60)} minutes.`,
    "I'll wait here and continue as soon as you're done.",
  ].join("\n");
}

/** One redemption attempt. `null` means "not yet", a throw means "start over". */
export async function redeemOnce(d: DeviceCodeResponse): Promise<Credentials | null> {
  const { status, json } = await post<{
    api_key?: string;
    email?: string;
    detail?: { error?: string };
  }>("/api/auth/device/token", { device_code: d.device_code, install_id: installId() });

  if (status === 200 && json.api_key) {
    const creds: Credentials = {
      apiKey: json.api_key,
      email: json.email ?? "",
      createdAt: new Date().toISOString(),
    };
    writeCredentials(creds);
    return creds;
  }
  const err = json?.detail?.error;
  // "authorization_pending" is the ONLY status that means keep waiting.
  if (err && err !== "authorization_pending") {
    throw new ToolError(
      err === "expired_token"
        ? "That sign-in code expired. Run this again to get a new one."
        : "That sign-in could not be completed. Run this again to start over.",
    );
  }
  return null;
}

/**
 * Wait out a sign-in the human has already been shown. Resolves with
 * credentials, or `null` if they are still not done — never throws on "pending",
 * because "not finished yet" is a normal answer, not an error.
 */
export async function awaitApproval(d: DeviceCodeResponse): Promise<Credentials | null> {
  const intervalMs = Math.max(2, d.interval || 5) * 1000;
  const deadline = Date.now() + GRACE_POLL_MS;
  // Try immediately: on a retry the approval has usually already landed.
  let creds = await redeemOnce(d);
  while (!creds && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    creds = await redeemOnce(d);
  }
  return creds;
}

/**
 * A sign-in started on an earlier tool call and not yet finished. In memory
 * only: this process outlives every individual call, and if it does restart we
 * simply start a new flow.
 */
let pending: DeviceCodeResponse | null = null;

/**
 * Run a tool call, handling "you need an account" without ever blocking on a
 * code the human has not seen.
 *
 * First 401  -> start a flow and return the code IMMEDIATELY. The agent shows
 *               it; nothing is gained by waiting, because until that message is
 *               on screen there is nobody to approve anything.
 * Later 401  -> they have seen it, so wait out the browser round trip, then
 *               retry the call once.
 *
 * If the backend has no device endpoints (an old deployment, or a client newer
 * than the server) the original error is re-thrown untouched, so a version skew
 * degrades to exactly today's behaviour instead of a hard wall.
 */
export async function withSignIn<T>(call: () => Promise<T>): Promise<T> {
  // HOSTED: no device flow, ever. It ends in writeCredentials(), which on a
  // shared container turns one user's browser sign-in into every user's
  // credential. A hosted caller presents a key its platform already holds, so
  // a 401 must surface as a 401 and say how to fix it — not start a flow that
  // would poison the process for everyone else.
  if (isHosted()) {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ToolError && e.status === 401) {
        // Point at /keys, NOT /device. The device page asks for a code that a
        // CLI printed and never displays a key — a hosted caller has neither,
        // so sending them there was a dead end dressed as an instruction.
        // /keys signs in with Google or GitHub and hands over a pasteable key.
        //
        // Written for the AGENT to relay, because on a hosted connector the
        // agent is the only thing that reads this. Hence the plain sentence a
        // non-developer can act on rather than a header-shaped instruction.
        throw new ToolError(
          "FetchSandbox needs a free API key for this step. Ask the user to " +
          "open https://fetchsandbox.com/keys, sign in with Google or GitHub, " +
          "click 'Create a key', and paste the key that appears into this " +
          "connector's authentication field (as a bearer token). Everything " +
          "already run so far — the sandbox and any failure scenario — keeps " +
          "working; only this step needs the key.",
          401,
        );
      }
      throw e;
    }
  }

  // Cheap, non-blocking: an approval that landed between calls is picked up here.
  if (pending && !readCredentials()?.apiKey) {
    const creds = await redeemOnce(pending).catch(() => null);
    if (creds) pending = null;
  }

  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ToolError) || e.status !== 401) throw e;

    if (pending) {
      const creds = await awaitApproval(pending).catch(() => null);
      if (creds) {
        pending = null;
        return await call();
      }
      throw new ToolError(signInMessage(pending), 401);
    }

    let started: DeviceCodeResponse;
    try {
      started = await startDeviceFlow();
    } catch {
      throw e; // no device endpoints — behave as before
    }
    pending = started;
    throw new ToolError(signInMessage(started), 401);
  }
}
