#!/usr/bin/env node
/**
 * fetchsandbox-mcp — Model Context Protocol server.
 *
 * Exposes three tools to any MCP client (Claude Code, Cursor, Cline, etc.):
 *   - import_spec      Ingest an OpenAPI spec; get a sandbox you can call.
 *   - list_workflows   List named, runnable workflows for an imported spec.
 *   - run_workflow     Execute a workflow and return the step trace.
 *
 * Talks to the FetchSandbox backend over HTTPS. Defaults to fetchsandbox.com;
 * override with FETCHSANDBOX_BASE_URL for stage or self-hosted use.
 *
 * Distribution: npx -y fetchsandbox-mcp.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ToolError, getBaseUrl } from "./client.js";
import { withSignIn } from "./signin.js";
import { detectIde } from "./session.js";
import { importSpecTool, runImportSpec } from "./tools/import_spec.js";
import { listSpecsTool, runListSpecs } from "./tools/list_specs.js";
import { listWorkflowsTool, runListWorkflows } from "./tools/list_workflows.js";
import { listRunsTool, runListRuns } from "./tools/list_runs.js";
import { runRunWorkflow, runWorkflowTool } from "./tools/run_workflow.js";
import {
  runRunAllWorkflows,
  runAllWorkflowsTool,
} from "./tools/run_all_workflows.js";
import { guideTool, runGuide } from "./tools/guide.js";
import { coachTool, runCoach } from "./tools/coach.js";
import {
  verifyBehaviorTool,
  runVerifyBehavior,
} from "./tools/verify_behavior.js";
import {
  submitProofTool,
  runSubmitProof,
  type ProofProbe,
} from "./tools/submit_proof.js";
import { quickrunTool, runQuickrun } from "./tools/quickrun.js";
import { findBugsTool, runFindBugs } from "./tools/find_bugs.js";
import { fixBugTool, runFixBug } from "./tools/fix_bug.js";
import { proveFixTool, runProveFix } from "./tools/prove_fix.js";
import { VERSION } from "./version.js";

const server = new Server(
  { name: "fetchsandbox", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    coachTool, // listed FIRST — the conversational entry point
    findBugsTool, // investigate: find production bugs in the user's own code
    fixBugTool, // fix: grounded remediation → git diff proposal
    proveFixTool, // prove: run FS's scenario buggy vs fixed → honest-green gate
    guideTool, // the deterministic single-shot router (still useful)
    quickrunTool, // run a bundled spec by slug — no import_spec/sandbox needed
    listSpecsTool,
    importSpecTool,
    listWorkflowsTool,
    runAllWorkflowsTool,
    runWorkflowTool,
    verifyBehaviorTool,
    submitProofTool, // attach the REAL app's before/after to the receipt
    listRunsTool,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    // withSignIn re-runs this on the one occasion it can succeed the second
    // time: a 401 that the human has since resolved in a browser.
    const result = await withSignIn(async () => {
      let result: unknown;
      const a = (args ?? {}) as Record<string, unknown>;
      switch (name) {
        case coachTool.name:
          result = await runCoach({
            intent: typeof a.intent === "string" ? a.intent : undefined,
            session_id:
              typeof a.session_id === "string" ? a.session_id : undefined,
            user_response:
              typeof a.user_response === "string" ? a.user_response : undefined,
            context:
              a.context && typeof a.context === "object"
                ? (a.context as Record<string, unknown>)
                : undefined,
          });
          break;
        case findBugsTool.name:
          result = await runFindBugs({
            path: typeof a.path === "string" ? a.path : undefined,
            spec: typeof a.spec === "string" ? a.spec : undefined,
            timeout_s:
              typeof a.timeout_s === "number" ? a.timeout_s : undefined,
          });
          break;
        case fixBugTool.name:
          result = await runFixBug({
            bug: typeof a.bug === "string" ? a.bug : "",
            fix_pattern:
              typeof a.fix_pattern === "string" ? a.fix_pattern : undefined,
            path: typeof a.path === "string" ? a.path : undefined,
            spec: typeof a.spec === "string" ? a.spec : undefined,
            timeout_s:
              typeof a.timeout_s === "number" ? a.timeout_s : undefined,
          });
          break;
        case proveFixTool.name:
          result = await runProveFix({
            diff: typeof a.diff === "string" ? a.diff : "",
            bug: typeof a.bug === "string" ? a.bug : undefined,
            scenario: typeof a.scenario === "string" ? a.scenario : undefined,
            path: typeof a.path === "string" ? a.path : undefined,
            timeout_s:
              typeof a.timeout_s === "number" ? a.timeout_s : undefined,
          });
          break;
        case guideTool.name:
          result = await runGuide({
            intent: typeof a.intent === "string" ? a.intent : "",
            // A caller-supplied context beats the automatic repo scan — an
            // explicit statement of what the repo integrates is a fact, not a
            // guess, and the dispatcher must not drop it on the floor.
            context:
              a.context && typeof a.context === "object"
                ? (a.context as Record<string, unknown>)
                : undefined,
            hints:
              a.hints && typeof a.hints === "object"
                ? (a.hints as Record<string, string>)
                : undefined,
          });
          break;
        case quickrunTool.name:
          result = await runQuickrun({
            spec_slug: typeof a.spec_slug === "string" ? a.spec_slug : "",
            workflow_name:
              typeof a.workflow_name === "string" ? a.workflow_name : "",
            scenario: typeof a.scenario === "string" ? a.scenario : undefined,
          });
          break;
        case listSpecsTool.name:
          result = await runListSpecs({
            filter: typeof a.filter === "string" ? a.filter : undefined,
          });
          break;
        case importSpecTool.name:
          result = await runImportSpec({
            url: typeof a.url === "string" ? a.url : undefined,
            content: typeof a.content === "string" ? a.content : undefined,
            name: typeof a.name === "string" ? a.name : undefined,
          });
          break;
        case listWorkflowsTool.name:
          result = await runListWorkflows({
            spec_id: typeof a.spec_id === "string" ? a.spec_id : "",
          });
          break;
        case listRunsTool.name:
          result = await runListRuns({
            sandbox_id: typeof a.sandbox_id === "string" ? a.sandbox_id : "",
            limit: typeof a.limit === "number" ? a.limit : undefined,
          });
          break;
        case runWorkflowTool.name:
          result = await runRunWorkflow({
            sandbox_id: typeof a.sandbox_id === "string" ? a.sandbox_id : "",
            workflow_name:
              typeof a.workflow_name === "string" ? a.workflow_name : "",
            // scenario was dropped here (schema + runRunWorkflow both support it),
            // silently forcing the happy path — the exact "agent skipped the proof"
            // failure this product exists to prevent. Forward it. (2026-07-15)
            scenario: typeof a.scenario === "string" ? a.scenario : undefined,
          });
          break;
        case runAllWorkflowsTool.name:
          result = await runRunAllWorkflows({
            sandbox_id: typeof a.sandbox_id === "string" ? a.sandbox_id : "",
            workflow_names: Array.isArray(a.workflow_names)
              ? (a.workflow_names as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
          });
          break;
        case verifyBehaviorTool.name:
          result = await runVerifyBehavior({
            bug_pattern_id:
              typeof a.bug_pattern_id === "string" ? a.bug_pattern_id : "",
            prompt: typeof a.prompt === "string" ? a.prompt : undefined,
            sandbox_id:
              typeof a.sandbox_id === "string" ? a.sandbox_id : undefined,
            flow_run_id:
              typeof a.flow_run_id === "string" ? a.flow_run_id : undefined,
          });
          break;
        case submitProofTool.name:
          result = await runSubmitProof({
            sandbox_id: typeof a.sandbox_id === "string" ? a.sandbox_id : "",
            flow_run_id: typeof a.flow_run_id === "string" ? a.flow_run_id : "",
            bug_pattern_id:
              typeof a.bug_pattern_id === "string" ? a.bug_pattern_id : "",
            summary: typeof a.summary === "string" ? a.summary : undefined,
            proofs: Array.isArray(a.proofs) ? (a.proofs as ProofProbe[]) : [],
          });
          break;
        default:
          throw new ToolError(`Unknown tool: ${name}`);
      }
      return result;
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: friendlyError(name, msg, e) }],
      isError: true,
    };
  }
});

function friendlyError(toolName: string, msg: string, err: unknown): string {
  // Surface common backend errors as agent-readable hints instead of raw HTTP.
  const status = err instanceof ToolError ? err.status : undefined;
  // A 401 carries the sign-in instructions verbatim — pass them straight
  // through rather than wrapping them in "Error:" and a hint.
  if (status === 401) return msg;
  const m = msg.toLowerCase();
  if (
    m.includes("not a valid openapi spec") ||
    m.includes("missing 'openapi'")
  ) {
    return (
      `Error: that file isn't an OpenAPI 3.x spec — it's missing the top-level "openapi" key. ` +
      `If you have a Swagger 2.0 spec, convert it first (e.g. with swagger-converter). Original: ${msg}`
    );
  }
  if (
    m.includes("non-public ip") ||
    m.includes("loopback") ||
    m.includes("did not resolve")
  ) {
    return (
      `Error: that URL can't be fetched — it's either non-public, points to a private network, or doesn't resolve. ` +
      `Public OpenAPI URLs (raw.githubusercontent.com, vendor docs portals) work; localhost and internal hosts don't. ` +
      `Original: ${msg}`
    );
  }
  if (m.includes("must be http")) {
    return `Error: spec URL must use http or https. Original: ${msg}`;
  }
  if (m.includes("spec url returned http 404")) {
    return (
      `Error: the spec URL returned 404. Double-check the link and try again. ` +
      `For GitHub, use the raw.githubusercontent.com URL, not the github.com page URL. Original: ${msg}`
    );
  }
  if (m.includes("exceeds") && m.includes("mb cap")) {
    return `Error: spec is too large. Hard cap is 20 MB. Original: ${msg}`;
  }
  if (m.includes("workflow") && m.includes("not found")) {
    return (
      `Error: that workflow name isn't recognized. Call list_workflows(spec_id=...) first to see ` +
      `the exact ids. Original: ${msg}`
    );
  }
  if (m.includes("sandbox") && m.includes("not found")) {
    return (
      `Error: that sandbox_id isn't recognized — sandboxes from previous sessions don't persist. ` +
      `Call import_spec again to get a fresh one. Original: ${msg}`
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return (
      `Error: backend returned ${status} (service unavailable). The MCP retried once; if you see this, ` +
      `the upstream is down. Try again in a minute. Original: ${msg}`
    );
  }
  if (status !== undefined && status >= 500) {
    // Not retried: RETRY_STATUSES covers 502/503/504 (transient upstream), and a
    // 500 is a real server-side failure that a second identical request repeats.
    // Say which call failed and that the work did NOT happen — an agent handed a
    // bare "HTTP 500" tends to fall back to proving the fix itself.
    return (
      `Error: ${toolName} failed with HTTP ${status} — the backend accepted the request and then ` +
      `errored, so NOTHING was proven or verified. This is not a timeout and not your input; ` +
      `retrying the same call will usually reproduce it. Report the failure to the user rather ` +
      `than substituting your own test. Original: ${msg}`
    );
  }
  if (m.includes("timed out")) {
    // Do NOT restate a budget here. Each call sets its own (30s default, 180s for
    // verify_behavior, a ~21min poll for prove_fix) and the underlying ToolError
    // already names the real one. A hardcoded "within 30s" contradicted a 3min
    // message in a measured run on 2026-09-07 and pointed the agent at the
    // network, which was not the problem.
    return (
      `Error: ${toolName} exceeded its time budget, so it produced no result. The work may still ` +
      `be running server-side; do not treat this as a failed proof, and do not substitute your own ` +
      `test harness for it. Original: ${msg}`
    );
  }
  // Default: pass through the message as-is.
  return `Error in ${toolName}: ${msg}`;
}

async function main() {
  // Print to stderr only — stdout is reserved for the MCP protocol.
  process.stderr.write(
    `[fetchsandbox-mcp ${VERSION}] connected to ${getBaseUrl()} (ide=${detectIde()})\n`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Export the configured server so integration tests can drive it over an
// in-memory transport — the real Claude/Cursor call loop, minus the OS process.
export { server };

// Only auto-connect stdio when run as the actual CLI entrypoint
// (npx fetchsandbox-mcp), NOT when imported by a test.
// Run stdio only when launched as the CLI entrypoint. Compare REAL paths:
// npx/npm invoke the bin through a symlink (node_modules/.bin/…), so a plain
// import.meta.url === argv[1] check is false under npx and the server never
// starts ("Connection closed"). realpathSync resolves the symlink so both npx
// and `node dist/index.js` match, while a test importing { server } does not.
let invokedAsCli = false;
try {
  invokedAsCli =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedAsCli = false;
}

if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`[fetchsandbox-mcp] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
