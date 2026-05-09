import { postJson, ToolError } from "../client.js";

export interface ImportSpecInput {
  url?: string;
  content?: string;
  name?: string;
}

interface WorkflowSummary {
  name: string;
  title: string;
  description: string;
  steps_count: number;
  source_type: string;
}

export interface ImportSpecResponse {
  spec_id: string;
  sandbox_id: string;
  name: string;
  version: string;
  endpoint_count: number;
  workflow_count: number;
  base_url: string;
  dashboard_url: string;
  workflows_preview: WorkflowSummary[];
  workflows_truncated: boolean;
  next_step_hint: string;
}

export const importSpecTool = {
  name: "import_spec",
  description:
    "Ingest an OpenAPI spec and get a working sandbox you can call immediately. " +
    "Use this when the user wants to try, test, or learn an API. Accepts a public " +
    "URL to an OpenAPI 3.x JSON or YAML file (e.g. raw.githubusercontent.com link), " +
    "or pasted spec content as a string. Returns a sandbox_id that can be used with " +
    "list_workflows and run_workflow, plus a base_url that proxies real-feeling, " +
    "schema-validated responses for every endpoint in the spec. " +
    "Pick this tool the moment the user mentions an OpenAPI URL or pastes a spec. " +
    "Note on URLs: this MCP runs locally (in the user's IDE process), but the spec " +
    "fetch happens on the FetchSandbox backend — so private addresses (localhost, " +
    "127.0.0.1, 10.x, 192.168.x, internal company hosts) will be rejected. For those, " +
    "have the user paste the spec content directly via the `content` parameter.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Public URL to an OpenAPI 3.x file (JSON or YAML). Use this for any " +
          "publicly reachable spec — GitHub raw links, docs portals, vendor SDKs.",
      },
      content: {
        type: "string",
        description:
          "Pasted OpenAPI spec content (JSON or YAML). Use this when the user " +
          "pastes the spec inline or has it on disk. Provide the raw text exactly.",
      },
      name: {
        type: "string",
        description:
          "Optional friendly name for the spec. Defaults to info.title from the " +
          "spec, or the URL hostname.",
      },
    },
    additionalProperties: false,
  },
} as const;

export async function runImportSpec(input: ImportSpecInput): Promise<ImportSpecResponse> {
  if (!input.url && !input.content) {
    throw new ToolError("Provide either 'url' or 'content'.");
  }
  if (input.url && input.content) {
    throw new ToolError("Provide 'url' or 'content', not both.");
  }
  return postJson<ImportSpecResponse>("/api/mcp/import-spec", input);
}
