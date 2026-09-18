/**
 * prove_fix — the GATE (investigate→fix→PROVE).
 *
 * After fix_bug returns a diff, this proves it: it ships the CURRENT (still
 * buggy) project + the diff to FetchSandbox, which applies the diff to a copy
 * and runs its OWN failure scenario against the buggy AND fixed real code in
 * Phalanx. The honest-green gate returns green ONLY on a measured buggy→fixed
 * flip — never on a self-report. If there's no scenario for the bug's class yet,
 * it declines to green rather than faking it.
 *
 * Calls POST /api/mcp/prove_fix (async job) then polls. Run this BEFORE applying
 * the diff to your tree — it needs the buggy state to reproduce against.
 */
import { ToolError } from "../client.js";
import { lastTwin } from "../twin.js";
import { startAndPoll } from "./jobs.js";
import { packDirToBase64, resolveWorkspaceDir } from "./pack.js";

export interface ProveFixInput {
  diff: string; // the fix diff from fix_bug
  bug?: string; // the finding (used to pick FetchSandbox's scenario)
  scenario?: string; // optional explicit scenario id
  sandbox_id?: string; // a twin from quickrun/run_workflow; auto-filled if omitted
  path?: string;
  timeout_s?: number;
}

export const proveFixTool = {
  name: "prove_fix",
  description:
    "THE PROOF STEP. The only way to establish that a fix actually works, and " +
    "the only thing that produces a shareable receipt. " +
    "Ship the STILL-BUGGY project plus your proposed diff: FetchSandbox applies " +
    "the diff to a copy and runs the SAME failure probe against the buggy and " +
    "the fixed tree, against real provider behaviour. Green ONLY on a measured " +
    "flip — the bug demonstrably present before, demonstrably gone after. " +
    "CALL THIS BEFORE YOU WRITE THE FIX TO DISK. prove_fix needs the broken " +
    "tree to reproduce against; applying the diff first makes a measured proof " +
    "impossible. " +
    "DO NOT SUBSTITUTE YOUR OWN TEST. A harness you write runs only the FIXED " +
    "code, so it can show a fix passing while proving nothing about whether the " +
    "bug was ever reproduced or is genuinely gone — and an agent-authored check " +
    "must never be reported to a user as 'proven' or 'verified'. If you have " +
    "already written one, still call this: your test and this proof answer " +
    "different questions.",
  inputSchema: {
    type: "object",
    properties: {
      diff: { type: "string", description: "The unified diff returned by fix_bug." },
      bug: {
        type: "string",
        description: "The finding being fixed — used to select FetchSandbox's scenario.",
      },
      scenario: {
        type: "string",
        description: "OPTIONAL. Explicit scenario id, if known.",
      },
      sandbox_id: {
        type: "string",
        description:
          "OPTIONAL. A twin from quickrun/run_workflow. Usually omit — the last " +
          "twin this session used is attached automatically.",
      },
      // PREVENT THE COPY, do not just refuse it.
      //
      // "Project dir. Defaults to cwd." told the agent nothing about mutation,
      // while prove_fix is documented as needing "the unfixed tree" — which
      // reads as "this may modify my files". So the rational plan is to copy
      // the project somewhere safe and pass the copy, and pack.ts then refuses
      // it for being outside the workspace. Measured four times across three
      // personas (p1_support twice, p4_senior twice) on three different builds.
      //
      // pack.ts now tells a copying agent how to recover, but the error still
      // counts against us — "a call that came back an ERROR is a finding even
      // when a later retry worked. It is usually us." This is the us.
      path: {
        type: "string",
        description:
          "OPTIONAL. The project root, as it is. Defaults to cwd. Do NOT copy " +
          "the project first: prove_fix builds its own before/after copies and " +
          "never writes to your tree. A path outside the workspace is refused.",
      },
      timeout_s: { type: "number", description: "OPTIONAL. Budget in seconds (default 300)." },
    },
    required: ["diff"],
    additionalProperties: false,
  },
} as const;

export async function runProveFix(input: ProveFixInput): Promise<{
  green_allowed: boolean;
  state?: string;
  reproduced?: boolean;
  verified?: boolean;
  reason?: string;
  /**
   * Why we could not recreate and run the app, in words for the developer.
   * Declared or tsc drops it.
   */
  cannot_run?: string;
  /**
   * The backend's instruction to the AGENT reading this result — the lever that
   * stops an autonomous agent writing its own ungated harness and reporting a
   * false green. The backend has always sent it. Until 2026-09-12 this type and
   * the return below both omitted it, so it was dropped at the client and no
   * agent ever saw it.
   */
  agent_guidance?: string;
  scenario?: unknown;
  receipt_url?: string;
  engine: string;
  /** Backend-authored text addressed to the HUMAN. Declared or tsc drops it. */
  message_for_user?: string;
}> {
  if (!input.diff || !input.diff.trim()) {
    throw new ToolError("diff is required — pass the diff from fix_bug.");
  }
  const dir = resolveWorkspaceDir(input.path);
  const { b64 } = packDirToBase64(dir);
  const timeout_s = Math.min(Math.max(input.timeout_s ?? 300, 30), 600);
  const body: Record<string, unknown> = {
    workspace_tar_b64: b64,
    diff: input.diff,
    timeout_s,
  };
  if (input.bug && input.bug.trim()) body.bug = input.bug.trim();
  if (input.scenario && input.scenario.trim()) body.scenario = input.scenario.trim();

  // THE TWIN, CARRIED FORWARD. quickrun/run_workflow returned a sandbox_id and
  // nothing passed it on, so prove_fix's declared tier -- the reviewed
  // invariant_check from brain.yaml -- had no twin to read back from and
  // declined every run. Measured on prod 2026-09-08: 11 of 12 declined for
  // "no twin supplied".
  //
  // Additive in both directions. No twin remembered -> the field is omitted and
  // the run takes exactly the path it takes today. A twin remembered but for
  // the WRONG provider -> the server declines it (it derives the provider from
  // the bug text) and the run is again unchanged. So this can make the declared
  // tier reachable; it cannot take anything away.
  const twin = (input.sandbox_id && input.sandbox_id.trim()) || lastTwin();
  if (twin) body.sandbox_id = twin;

  const raw = await startAndPoll("/api/mcp/prove_fix", body, {
    // Budget for the worst case: no curated scenario → synthesize a probe
    // (~5 min) + two probe runs (buggy + fixed). Returns as soon as it's done.
    maxMs: (timeout_s * 3 + 360) * 1000,
  });
  if (raw.status === "error") {
    throw new ToolError(`FetchSandbox prove failed: ${raw.error ?? "unknown error"}`);
  }
  return {
    green_allowed: raw.green_allowed === true,
    state: raw.state as string | undefined,
    reproduced: raw.reproduced as boolean | undefined,
    verified: raw.verified as boolean | undefined,
    reason: raw.reason as string | undefined,
    cannot_run: raw.cannot_run as string | undefined,
    agent_guidance: raw.agent_guidance as string | undefined,
    scenario: raw.scenario,
    receipt_url: raw.receipt_url as string | undefined,
    engine: (raw.engine as string) ?? "fetchsandbox",
    // THE FIFTH WHITELIST. Every field the backend adds must be named
    // here or it is invisible — this is what hid next_actions for weeks.
    //
    // Renamed from `notice` on 2026-09-12. A persona run proved the old name
    // was invisible in a different way: the field arrived, and the agent
    // relayed none of it to the person. `notice` sat beside spec and
    // confidence, so it read as data to act on rather than words to pass on.
    message_for_user: (raw.message_for_user as string) ?? undefined,
  };
}
