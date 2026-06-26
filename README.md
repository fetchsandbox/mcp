# fetchsandbox-mcp

Turn any OpenAPI spec into a working sandbox your AI agent can use, right from your IDE.

This is the Model Context Protocol (MCP) server for [FetchSandbox](https://fetchsandbox.com). It exposes three tools that let any MCP-compatible agent ingest an OpenAPI spec, list its workflows, and run them — with realistic, schema-validated responses for every endpoint.

> ⭐ **If FetchSandbox saves you a debugging session, star this repo.** It helps people find the project and helps us prioritize what to build next.

## Why

Agents read raw OpenAPI specs and hallucinate. They guess field names, invent IDs that won't exist, and produce broken curl commands. FetchSandbox turns the spec into a stateful, AJV-validated sandbox so the agent can actually call the API and see real-shaped responses.

Plug it into your IDE once, and any time you ask your agent "let me try the Stripe API" or "show me the GitHub issue lifecycle," it can do that — for real, end-to-end.

## Install — by agent

The MCP runs as a stdio process spawned by your IDE. There's nothing to install globally — `npx` runs the published version on demand. We recommend pinning to `@latest` so each session auto-upgrades to the current release; otherwise npm caches the first version it saw and silently drifts behind.

Pick your tool below, paste the snippet, restart.

### Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp@latest"]
    }
  }
}
```

Quit and reopen Claude Desktop (Cmd+Q, then reopen — not just close window).

### Claude Code

User-level (all projects): `~/.claude/settings.json`. Or project-level: `.mcp.json` in the repo root.

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp@latest"]
    }
  }
}
```

Restart the Claude Code session.

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project)

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp@latest"]
    }
  }
}
```

Restart Cursor.

### Cline (VS Code extension)

Open the Cline panel → settings cog → MCP Servers → add a new server with:

- Command: `npx`
- Args: `-y fetchsandbox-mcp@latest`

Reload the VS Code window.

### Continue.dev

File: `~/.continue/config.yaml`

```yaml
mcpServers:
  - name: fetchsandbox
    command: npx
    args:
      - -y
      - fetchsandbox-mcp@latest
```

Restart your IDE.

### Codex CLI (OpenAI)

File: `~/.codex/config.toml`

```toml
[mcp_servers.fetchsandbox]
command = "npx"
args = ["-y", "fetchsandbox-mcp@latest"]
```

Restart Codex.

### Zed

File: `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "fetchsandbox": {
      "command": {
        "path": "npx",
        "args": ["-y", "fetchsandbox-mcp@latest"]
      }
    }
  }
}
```

### GitHub Copilot

GitHub Copilot doesn't currently support the Model Context Protocol. Track [github/copilot#feedback](https://github.com/orgs/community/discussions) for updates. In the meantime, run any MCP-compatible chat (Claude Code, Cursor, Cline) alongside Copilot.

### Anything else (Roo, Goose, etc.)

If your agent speaks MCP, it accepts a stdio command. Use:

- Command: `npx`
- Args: `["-y", "fetchsandbox-mcp@latest"]`

## Try it now

After restarting your agent, paste any of these prompts. Each hits a hand-curated workflow with realistic IDs and real state transitions.

### Stripe — accept a payment

> Use fetchsandbox to import the Stripe spec from `https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json` and run the `accept_payment` workflow. Show me the trace.

The agent imports 587 endpoints, matches the bundled curated Stripe sandbox, and runs a 6-step workflow: create customer (`cus_…`) → create PaymentIntent (`pi_…`, `$49.99 USD`, `requires_payment_method`) → confirm (`requires_capture`) → capture (`succeeded`) → retrieve → verify webhooks (`payment_intent.created`, `payment_intent.succeeded`).

### Twilio — send an SMS

> Use fetchsandbox to import the Twilio Messaging spec from `https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/yaml/twilio_messaging_v1.yaml` and run the `send_sms` workflow.

The agent imports the messaging API and runs a curated send-and-verify flow with realistic Twilio-formatted message SIDs (`SM…`).

### GitHub — issue lifecycle

> Use fetchsandbox to import the GitHub REST API from `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json` and run the `issue_lifecycle` workflow.

The agent walks the create → comment → close → reopen flow against a real-shaped GitHub sandbox.

### Paddle — paste-content variant

If a vendor doesn't publish their spec at a stable URL (Paddle, Notion, Linear), paste the content directly:

> Here's the Paddle Billing OpenAPI spec — `<paste JSON or YAML>`. Use fetchsandbox to import it and run the `subscriptions_canceled` workflow.

Same engine path; same curated quality if the spec's `info.title` matches a bundled config.

### Any other API

> Use fetchsandbox to import `<your OpenAPI URL>` — list the workflows and tell me which is most interesting.

For specs we don't have curated configs for, the engine auto-enumerates `create + verify` workflows for every detected resource. Honest about what it shows: UUIDs instead of vendor-style IDs, generic enum values instead of API-specific ones — but the request/response shape and template substitution between steps still work.

## Tools

### `import_spec`

Ingest an OpenAPI 3.x spec and get a sandbox you can call. Pass either a public URL or pasted content.

```
url:     "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
content: "<paste OpenAPI JSON or YAML here>"
name:    "Optional friendly name"
```

Returns `spec_id`, `sandbox_id`, `base_url` (proxy that serves real-shaped responses), `workflows_preview` (first 10), `matched_bundled` (true if we matched a curated config), and a `dashboard_url` to view everything in the browser.

### `list_workflows`

List the named, runnable workflows the engine inferred or curated for an imported spec.

```
spec_id: "<id from import_spec>"
```

### `run_workflow`

Execute one workflow and return the step-by-step request/response trace. Template variables (`{{step1.id}}`) are resolved automatically between steps. The response now includes a `share_url` per run — a public receipt URL you can paste into a PR or share with a teammate.

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

## Want to see it catch real bugs?

Try the **[FetchSandbox Playground](https://github.com/fetchsandbox/playground)** — five small brownfield apps with planted bugs in real API integrations (Stripe webhook dedup, Resend bounce drops, Clerk JWT verification, AgentMail attachment handling, Surge opt-out). Clone, run, point your agent at one, and see whether FetchSandbox catches the bug. PRs with your session findings welcome.

## License

MIT — see [LICENSE](LICENSE).

## Links

- [FetchSandbox](https://fetchsandbox.com) — main site, docs, dashboard
- [Playground](https://github.com/fetchsandbox/playground) — try it on planted bugs
- [npm package](https://www.npmjs.com/package/fetchsandbox-mcp) — `npx fetchsandbox-mcp@latest`
- [Issues](https://github.com/fetchsandbox/mcp/issues) — bug reports, feature asks
