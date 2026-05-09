# fetchsandbox-mcp

Turn any OpenAPI spec into a working sandbox your AI agent can use, right from your IDE.

This is the Model Context Protocol (MCP) server for [FetchSandbox](https://fetchsandbox.com). It exposes three tools that let Claude Code, Cursor, Cline, or any MCP-compatible client ingest an OpenAPI spec, list its workflows, and run them — with realistic, schema-validated responses for every endpoint.

## Why

Agents read raw OpenAPI specs and hallucinate. They guess field names, invent IDs that won't exist, and produce broken curl commands. FetchSandbox turns the spec into a stateful, AJV-validated sandbox so the agent can actually call the API and see real-shaped responses.

Plug it into your IDE once, and any time you ask your agent "let me try the Stripe API" or "show me the GitHub issue lifecycle," it can do that — for real, end-to-end.

## Install

The MCP runs as a stdio process spawned by your IDE. There's nothing to install globally — `npx` runs the latest published version on demand.

### Claude Code (`~/.config/claude/claude_code_settings.json` or your project's `.mcp.json`)

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp"]
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp"]
    }
  }
}
```

Restart your IDE after editing the config. The tools `import_spec`, `list_workflows`, and `run_workflow` become available to your agent.

## Tools

### `import_spec`

Ingest an OpenAPI 3.x spec and get a sandbox you can call. Pass either a public URL or pasted content.

```
url:     "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
content: "<paste OpenAPI JSON or YAML here>"
name:    "Optional friendly name"
```

Returns `spec_id`, `sandbox_id`, `base_url` (proxy that serves real-shaped responses), workflow list, and a `dashboard_url` to view everything in the browser.

### `list_workflows`

List the named, runnable workflows the engine inferred or curated for an imported spec.

```
spec_id: "<id from import_spec>"
```

### `run_workflow`

Execute one workflow and return the step-by-step request/response trace. Template variables (`{{step1.id}}`) are resolved automatically between steps.

```
sandbox_id:    "<id from import_spec>"
workflow_name: "<id or name from list_workflows>"
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `FETCHSANDBOX_BASE_URL` | `https://fetchsandbox.com` | Override for stage testing or self-hosted backends. |
| `FETCHSANDBOX_TELEMETRY` | (on) | Set to `0` to disable anonymous usage telemetry. |

### What we record

When telemetry is on, each tool call records: an opaque per-machine session id (random UUID stored at `~/.fetchsandbox/session.json`), the tool name, latency, success/failure, and the spec URL or `"pasted"`. We do **not** record spec content, request bodies, or credentials. We use this to count daily-active sessions and learn which APIs people are bringing to the platform.

To opt out:

```bash
export FETCHSANDBOX_TELEMETRY=0
```

## Example session

> **You:** Try the Stripe API. Use this spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
>
> **Agent:** *(calls `import_spec`)* Imported. 471 endpoints, 12 workflows including customer-create, subscription-lifecycle, refund-flow.
>
> **You:** Run the subscription-lifecycle one.
>
> **Agent:** *(calls `run_workflow`)* All 5 steps passed: created customer (cus_LJ4nQ...), attached payment method (pm_8K2...), created subscription (sub_R6F...), updated to a different price (sub.items.0 swap), canceled subscription. Here's the trace: ...

## License

MIT — see [LICENSE](LICENSE).

## Links

- [FetchSandbox](https://fetchsandbox.com)
- [Source code](https://github.com/fetchsandbox/mcp)
- [Issues](https://github.com/fetchsandbox/mcp/issues)
