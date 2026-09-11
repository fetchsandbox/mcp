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
    "REQUIRED: pass EITHER `url` OR `content` — never just `name` alone (name is " +
    "a display label, not a lookup). If the user mentions a popular API by name " +
    "(Stripe, GitHub, Twilio, Notion, OpenAI, etc.), FIRST call `list_specs` " +
    "with a filter to confirm it's in the catalog, then call import_spec with " +
    "that vendor's public OpenAPI URL (e.g. Stripe: " +
    "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json). " +
    "The backend content-hashes the spec and auto-matches to the bundled sandbox " +
    "when applicable. Returns sandbox_id, workflows_preview, and a base_url that " +
    "proxies schema-validated responses. Private URLs (localhost, 10.x, 192.168.x) " +
    "are rejected by the backend — use `content` to paste those inline.",
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
          "Optional DISPLAY label only — NOT a lookup key. Defaults to " +
          "info.title from the spec. To resolve a known API by name " +
          "(\"Stripe\", \"GitHub\"), call list_specs first.",
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
