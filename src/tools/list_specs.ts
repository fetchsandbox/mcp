import { getJson, ToolError } from "../client.js";

interface BackendSpec {
  id: string;
  name: string;
  slug?: string;
  version?: string;
  description?: string;
  endpoints_count?: number;
  tags?: string[];
  created_at?: string;
}

export interface ListSpecsInput {
  filter?: string;
}

export interface SpecSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  endpoints_count: number;
  tags: string[];
}

export interface ListSpecsResponse {
  total: number;
  specs: SpecSummary[];
}

export const listSpecsTool = {
  name: "list_specs",
  description:
    "Browse the FetchSandbox spec catalog — every API (Stripe, GitHub, " +
    "Twilio, Notion, OpenAI, Polar, GitLab, and 40+ more) that has a " +
    "ready-to-use sandbox with curated workflows. Use when the user asks " +
    "'what APIs do you support?', 'what specs are available?', 'show me " +
    "the catalog', 'do you have <X>?', or wants to explore before " +
    "committing to one. Returns each spec's slug (use as `name` arg to " +
    "import_spec), description, endpoint count, and tags. Pass `filter` to " +
    "narrow by substring (e.g., filter='pay' returns Stripe, Paddle, " +
    "Polar).",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description:
          "Optional case-insensitive substring filter. Matches against " +
          "spec name, slug, description, and tags. Omit to return the full " +
          "catalog.",
      },
    },
    additionalProperties: false,
  },
} as const;

export async function runListSpecs(
  input: ListSpecsInput,
): Promise<ListSpecsResponse> {
  const raw = await getJson<BackendSpec[]>("/api/specs");
  if (!Array.isArray(raw)) {
    throw new ToolError("Backend returned unexpected shape for /api/specs.");
  }
  const all: SpecSummary[] = raw.map((s) => ({
    id: s.id,
    name: s.name || s.slug || s.id,
    slug: s.slug || "",
    description: s.description || "",
    endpoints_count: s.endpoints_count ?? 0,
    tags: Array.isArray(s.tags) ? s.tags.slice(0, 12) : [],
  }));
  const filter = (input.filter || "").trim().toLowerCase();
  const specs = filter
    ? all.filter((s) => {
        const hay = [
          s.name,
          s.slug,
          s.description,
          ...s.tags,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(filter);
      })
    : all;
  return {
    total: specs.length,
    specs,
  };
}
