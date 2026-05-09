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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ToolError, getBaseUrl } from "./client.js";
import { importSpecTool, runImportSpec } from "./tools/import_spec.js";
import { listWorkflowsTool, runListWorkflows } from "./tools/list_workflows.js";
import { runRunWorkflow, runWorkflowTool } from "./tools/run_workflow.js";

const VERSION = "0.1.0";

const server = new Server(
  { name: "fetchsandbox", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [importSpecTool, listWorkflowsTool, runWorkflowTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result: unknown;
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
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
      case runWorkflowTool.name:
        result = await runRunWorkflow({
          sandbox_id: typeof a.sandbox_id === "string" ? a.sandbox_id : "",
          workflow_name: typeof a.workflow_name === "string" ? a.workflow_name : "",
        });
        break;
      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
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
  const m = msg.toLowerCase();
  if (m.includes("not a valid openapi spec") || m.includes("missing 'openapi'")) {
    return (
      `Error: that file isn't an OpenAPI 3.x spec — it's missing the top-level "openapi" key. ` +
      `If you have a Swagger 2.0 spec, convert it first (e.g. with swagger-converter). Original: ${msg}`
    );
  }
  if (m.includes("non-public ip") || m.includes("loopback") || m.includes("did not resolve")) {
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
    return (
      `Error: spec is too large. Hard cap is 20 MB. Original: ${msg}`
    );
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
  if (m.includes("timed out")) {
    return (
      `Error: backend didn't respond within 30s. Large specs (Stripe, GitHub) sometimes take 10-15s ` +
      `on first import; if it's still slow, try a different network. Original: ${msg}`
    );
  }
  // Default: pass through the message as-is.
  return `Error in ${toolName}: ${msg}`;
}

async function main() {
  // Print to stderr only — stdout is reserved for the MCP protocol.
  process.stderr.write(
    `[fetchsandbox-mcp ${VERSION}] connected to ${getBaseUrl()}\n`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[fetchsandbox-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
