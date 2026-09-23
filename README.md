# fetchsandbox-mcp

<a href="https://www.producthunt.com/products/fetchsandbox?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-fetchsandbox-mcp" target="_blank" rel="noopener noreferrer"><img alt="FetchSandbox MCP - The MCP that proves your AI's integration fixes work | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1223147&theme=light"></a>

Also on [Smithery](https://smithery.ai/servers/fetchsandbox/mcp), [npm](https://www.npmjs.com/package/fetchsandbox-mcp) and the [official MCP registry](https://registry.modelcontextprotocol.io/v0/servers?search=fetchsandbox).

A deterministic verification engine for agents, as an MCP server for
[FetchSandbox](https://fetchsandbox.com).

Your agent writes an integration. This checks whether it actually works — against
a sandbox that behaves like the real provider, including the failures: retried
webhooks, declined cards, rate limits, auth errors.

When it finds a bug, it can propose a fix and then prove it: the same failure is
run against your code before and after the diff. Green only if it reproduced
first and stopped after. You get a receipt URL either way.

## Install

Same stdio command everywhere. `npx` fetches the current version, so there's
nothing to install.

```json
{
  "mcpServers": {
    "fetchsandbox": {
      "command": "npx",
      "args": ["-y", "fetchsandbox-mcp@latest"],
      "env": { "FETCHSANDBOX_API_KEY": "fsk_your_key_here" }
    }
  }
}
```

The key is optional — leave `env` out and everything still runs. Get one at
**https://fetchsandbox.com/keys** when you want receipts that outlive 15 days.
See [Accounts](#accounts).

| Client | File |
|---|---|
| Claude Code | `.mcp.json` in your project root, or `claude mcp add` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json`, or `.cursor/mcp.json` in the repo |
| Zed | `~/.config/zed/settings.json`, under `context_servers` |
| Codex | `~/.codex/config.toml`, as `[mcp_servers.fetchsandbox]` |

Restart the client afterwards. Anything else that speaks MCP takes the same
command and args.

### No terminal? Use the hosted endpoint

Browser-based builders — Lovable, Bolt, v0 — can't run `npx`. They connect
straight to the hosted streamable-HTTP transport instead:

```
https://fetchsandbox.com/mcp/v1
```

Authenticate with a **Bearer token**, not "None" — paste the key from
https://fetchsandbox.com/keys.

Same twins, same scenarios. Three tools are refused there and only three:
`find_bugs`, `fix_bug` and `prove_fix` read your project from disk, and a
hosted server has no copy of it. Everything else — `quickrun`, `run_workflow`,
`list_workflows`, `list_scenarios`, `set_scenario`, `verify_behavior` — needs
no filesystem and works exactly as it does over stdio. To analyse your own
code, run `npx fetchsandbox-mcp` locally in the project you want looked at.

## Using it

Describe the problem the way you'd describe it to a colleague. You don't need to
name a tool.

> Customers are reporting more seats than they bought after a Paddle payment.
> Can you find out why?

The agent works through: route the symptom, reproduce it against the provider
sandbox, read your code, get a fix, prove the fix on your code. Each step hands
back what the next one needs.

One thing worth knowing, because it's easy to get backwards: `prove_fix` needs
the **unfixed** tree. Run it before you write the diff to disk, or there's no
bug left to reproduce and no proof to be had.

## Accounts

You don't need one to start. Install it, ask a question, and everything runs.

The first time a run produces something worth keeping — a receipt, or a set of
findings — you'll get a short code and a link. Signing in takes about twenty
seconds and does two things: the evidence behind your receipts stops being
archived after 15 days, and the runs from that machine collect in one place.
You'll be asked at most once a day, and never once you're signed in.

For CI, the hosted endpoint, or anywhere a browser isn't available, set a key
instead. Create one at **https://fetchsandbox.com/keys** — sign in, then
"Create a key". It looks like `fsk_...`.

In an MCP client config, it goes in `env`:

```json
"env": { "FETCHSANDBOX_API_KEY": "fsk_your_key_here" }
```

In a shell or CI:

```
export FETCHSANDBOX_API_KEY=fsk_your_key_here
```

On the hosted endpoint, send it as `Authorization: Bearer fsk_...`.

The key is also written to `~/.fetchsandbox/credentials.json` when you sign in
from an editor; the environment variable always wins.

## Tools

Start with `guide`. It picks the right ones for what you asked.

**Finding and fixing**

| Tool | What it does | Arguments |
|---|---|---|
| `guide` | Routes a symptom to a spec, workflow and known failure class | `intent*`, `hints` |
| `find_bugs` | Audits your project against known integration failure classes. No git remote needed — it reads the directory you point it at | `path`, `spec`, `timeout_s` |
| `fix_bug` | Returns a `git diff` for one finding. Doesn't touch your files | `bug*`, `fix_pattern`, `path`, `spec`, `timeout_s` |
| `prove_fix` | Runs the failure against your code before and after the diff. Green only on a measured flip | `diff*`, `bug`, `scenario`, `sandbox_id`, `path`, `timeout_s` |

**Running the sandbox**

This is the group that needs no filesystem, so it is also the whole of what a
browser-based builder can use over the hosted endpoint.

| Tool | What it does | Arguments |
|---|---|---|
| `quickrun` | Runs a workflow against a bundled spec in one call. Returns `sandbox_id` and `flow_run_id` | `spec_slug*`, `workflow_name*`, `scenario` |
| `verify_behavior` | Shows a failure class on reference handlers — buggy vs fixed | `bug_pattern_id*`, `prompt`, `sandbox_id`, `flow_run_id` |
| `run_workflow` | Runs one workflow on a sandbox you already have | `sandbox_id*`, `workflow_name*`, `scenario` |
| `run_all_workflows` | Runs several in one call | `sandbox_id*`, `workflow_names` |
| `list_workflows` | Workflows AND failure scenarios for a spec, in one answer | `spec_slug` or `spec_id` |
| `list_scenarios` | The failures a spec can inject, with what each one does | `spec_slug` or `spec_id` |
| `set_scenario` | Arms a failure on a sandbox, so the next call misbehaves | `sandbox_id*`, `scenario*` |
| `list_runs` | Past runs for a sandbox | `sandbox_id*`, `limit` |

**Bringing your own spec**

| Tool | What it does | Arguments |
|---|---|---|
| `list_specs` | Specs already available | `filter` |
| `import_spec` | Ingests an OpenAPI 3.x spec by URL or pasted content. Returns a callable sandbox | `url`, `content`, `name` |
| `submit_proof` | Publishes a receipt for a run | `sandbox_id`, `flow_run_id`, `bug_pattern_id`, `summary`, `proofs` |
| `coach` | Multi-turn help building an integration | `intent`, `session_id`, `user_response`, `context` |

`*` = required.

## What leaves your machine

`find_bugs`, `fix_bug` and `prove_fix` package the directory you point them at
and upload it for analysis. Worth saying plainly, because the previous wording
here implied the opposite.

Excluded before packing: `.git`, `node_modules` and build output, agent
instruction files, and anything credential-shaped — `.env*`, `*.pem`, `*.key`,
`id_rsa*`, `*.tfstate`, `.npmrc`, `.aws`, `.ssh` and more.

Then the archive is read back and **refused** if it still contains something
shaped like a live credential, wherever it lives and whatever it is called. A
key in `config/local.yml` stops the upload and names the file. Patterns only
cover what someone thought of; the scan is there for the rest.

If you would rather nothing left at all, the analysis needs the source today.
That is the honest state.

### Receipts are public to anyone holding the link

`submit_proof` attaches the real requests and responses from your app's
before/after run to the receipt page, so the receipt shows your code's own
behaviour. That page is served without a login — that is the point of it, you
drop the link in a PR — which means the bodies on it are readable by anyone who
has the link.

The probes run against the FetchSandbox twin, not your provider, so the data is
sandbox data. But the request bodies are the ones your app built, and those can
carry values from your config. Look at a receipt before you share it.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `FETCHSANDBOX_API_KEY` | none | Sign in without a browser. Overrides the stored credentials |
| `FETCHSANDBOX_BASE_URL` | `https://fetchsandbox.com` | Point at a different backend |
| `FETCHSANDBOX_TELEMETRY` | on | Set to `0` to turn off |

Telemetry records an opaque per-machine id (a random UUID in
`~/.fetchsandbox/session.json`), the tool name, latency, and whether the call
succeeded. Not spec content, not request bodies, not credentials. It's how we
count sessions and see which APIs people bring.

Once you sign in, calls are also attributed to your account — that is the point
of signing in, and it is what lets your runs appear in one place.

`FETCHSANDBOX_TELEMETRY=0` stops the per-machine id being sent, so calls are no
longer linked to your machine. It does not make a call invisible: the server
still records that a tool ran, because it is the thing running it. And if you
are signed in, your key identifies you regardless — that is what a key is. To
be unattributed, don't sign in.

## License

MIT — see [LICENSE](LICENSE).

- [fetchsandbox.com](https://fetchsandbox.com)
- [Source](https://github.com/fetchsandbox/mcp) · [Issues](https://github.com/fetchsandbox/mcp/issues)
