import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { postJson } from "../client.js";
import { scanRepoSignals } from "./repo_signals.js";

/**
 * Detect provider SDKs installed in the user's repo — the deterministic spec
 * signal. The MCP server runs in the user's project (cwd), so it can read the
 * manifest directly. We send raw package names; the backend maps them to specs
 * (single source of truth for the SDK→spec table). Best-effort, never throws.
 */
export function detectRepoDependencies(cwd: string = process.cwd()): string[] {
  const deps = new Set<string>();
  const tryFile = (rel: string, parse: (t: string) => void) => {
    try {
      const p = join(cwd, rel);
      if (existsSync(p)) parse(readFileSync(p, "utf8"));
    } catch {
      /* ignore unreadable/malformed manifest */
    }
  };
  tryFile("package.json", (t) => {
    const j = JSON.parse(t);
    for (const grp of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const k of Object.keys(j[grp] || {})) deps.add(k);
    }
  });
  tryFile("requirements.txt", (t) => {
    for (const line of t.split("\n")) {
      const name = line.trim().split(/[=<>~!\[ ;#]/)[0];
      if (name) deps.add(name);
    }
  });
  tryFile("pyproject.toml", (t) => {
    for (const m of t.matchAll(/^\s*["']?([a-zA-Z0-9._@/-]+)["']?\s*[=:]/gm)) {
      if (m[1]) deps.add(m[1]);
    }
  });
  return [...deps];
}

/**
 * `coach` — server-side conversational orchestrator.
 *
 * v0.1 of the MCP-only integration coach (replaces the curl-pipe-to-bash
 * skill install for the conversational flow). The LLM calls `coach` once
 * per turn; the server tracks session state and tells the LLM what to
 * say to the user + what tool (if any) to call next.
 *
 * Call shapes:
 *   - First turn: { intent: "<user's ask>" }
 *   - Subsequent: { session_id, user_response: "<user's reply>" }
 *
 * The server holds the 7-step state machine (intake → comprehend →
 * elicit → route → prove → propose → done). The LLM is a thin relay:
 * say the `message_for_user`, then act on `next_action`:
 *   - "wait_for_user" — say the message, wait for the user's reply,
 *                       call coach again with their reply
 *   - "call_tool"      — say the message, call the named `tool_call`
 *                       with the args, optionally fold the result back
 *                       into the next coach turn
 *   - "done"           — say the message, end the integration session
 */

export interface CoachInput {
  intent?: string;
  session_id?: string;
  user_response?: string;
  context?: Record<string, unknown>;
}

export interface CoachOption {
  label: string;            // human-readable picker row text
  value: string;            // pass back as user_response on next coach call
  description?: string;     // optional sub-line (e.g. "currency=eur · 3DS=true")
}

export interface CoachResponse {
  session_id: string;
  step: string;
  message_for_user: string;
  next_action: "wait_for_user" | "call_tool" | "done";

  // Structured question for native AskUserQuestion picker UI
  question?: string;
  options?: CoachOption[];
  default_option?: string;  // one of options[i].value
  allow_freeform?: boolean; // adds "Other..." escape row

  tool_call?: { tool: string; args: Record<string, unknown> };
  diff?: Record<string, unknown>;
  compliance_notes?: Array<{ severity: string; note: string }>;
}

export const coachTool = {
  name: "coach",
  description:
    "Conversational integration coach for FetchSandbox. Server-side " +
    "orchestrator that walks the user through adding an API integration " +
    "(payments / email / auth / etc.) — intake the goal, elicit " +
    "domain-aware discovery questions from the spec's brain.yaml, route " +
    "to the right workflow, prove the contract via FetchSandbox, surface " +
    "compliance notes. Call this BEFORE any other FetchSandbox tool when " +
    "the user has an open-ended 'help me add X', 'integrate X', 'test my X " +
    "integration' ask. " +
    "BEHAVIOR — strict, do exactly this each turn: " +
    "(1) Say `message_for_user` to the user (verbatim or lightly " +
    "paraphrased to fit your voice — but don't add new content). " +
    "(2) If `next_action=wait_for_user` AND `options` is present + " +
    "non-empty: USE YOUR CLIENT'S NATIVE QUESTION-PICKER TOOL (in " +
    "Cursor / Claude Code this is `AskUserQuestion`) to render the " +
    "lettered picker with the `question` text, the `options[].label` " +
    "as rows, `default_option` as default, and an 'Other...' freeform " +
    "row when `allow_freeform=true`. When the user picks or types, " +
    "call coach again with `{session_id, user_response: <picked " +
    "value or freeform text>}`. " +
    "(3) If `next_action=wait_for_user` AND no `options`: just wait " +
    "for free text. " +
    "(4) If `next_action=call_tool`: invoke `tool_call.tool` with " +
    "`tool_call.args`, then call coach again with the result in " +
    "`context`. " +
    "(5) If `next_action=done`: end the session. " +
    "The state machine is server-side — DON'T try to predict the next " +
    "step or skip ahead; let the server drive.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "User's free-form integration ask, on the FIRST call only. " +
          "Pass through verbatim — the server's intent router benefits " +
          "from the full phrasing.",
      },
      session_id: {
        type: "string",
        description:
          "Returned by a previous coach call. Required on every call " +
          "after the first.",
      },
      user_response: {
        type: "string",
        description:
          "The user's reply to the previous coach turn's question. " +
          "Required when the previous turn returned `next_action: " +
          "wait_for_user`.",
      },
      context: {
        type: "object",
        description:
          "Optional context the LLM brings to the turn — e.g. a " +
          "summary of the user's repo (if you ran an introspect step), " +
          "or the result of a previously-instructed `tool_call`.",
      },
    },
  },
};

export async function runCoach(input: CoachInput): Promise<CoachResponse> {
  // On the first turn (the user's ask), auto-attach repo signals so the router
  // can pin the provider from FACTS, not a guess: `dependencies` + `detected_specs`
  // (presence) and `code_probe` (per provider, which webhook guard its handler
  // carries — the funnel's code-probe leg). Runs where the repo is (this MCP
  // process's cwd); only the compact JSON travels, never source. Best-effort.
  if (input.intent && !input.session_id) {
    const existing = (input.context || {}) as Record<string, unknown>;
    if (!existing.dependencies && !existing.detected_specs && !existing.code_probe) {
      try {
        const patch: Record<string, unknown> = {};
        const deps = detectRepoDependencies();
        if (deps.length) patch.dependencies = deps;
        const sig = scanRepoSignals();
        if (sig.detected_specs.length) patch.detected_specs = sig.detected_specs;
        if (Object.keys(sig.code_probe).length) patch.code_probe = sig.code_probe;
        if (Object.keys(patch).length) {
          input = { ...input, context: { ...existing, ...patch } };
        }
      } catch {
        /* signals are best-effort — never block the call on a repo scan */
      }
    }
  }
  return postJson<CoachResponse>("/api/mcp/coach", input);
}
