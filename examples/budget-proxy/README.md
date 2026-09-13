# Budget-scoped runs

A small MCP proxy that gives an agent a fixed allowance of FetchSandbox runs and
stops cleanly when it is spent.

It speaks MCP on both sides: your agent connects to this, and this connects to
`fetchsandbox-mcp`. Nothing about FetchSandbox changes, and no server-side
metering exists — this process is the only thing enforcing the limit.

```json
{ "mcpServers": { "fetchsandbox": {
    "command": "node",
    "args": ["examples/budget-proxy/index.mjs"],
    "env": { "FS_BUDGET_RUNS": "2" } } } }
```

## What it charges for

**The tool that was called.** These five consume budget:

`quickrun` · `run_workflow` · `run_all_workflows` · `verify_behavior` · `prove_fix`

Everything else is free. `guide`, `list_specs`, `list_workflows`, `find_bugs`,
`fix_bug` and the rest never consume budget, because an agent that cannot look
around will guess instead.

Two obvious alternatives are both wrong, and one of them we shipped first.

**Counting `tools/call`** treats `list_specs` and a five-step `quickrun` as
equal. One reads a list; the other stands up an environment and drives a
workflow through it. A budget like that either starves real work or lets it run
free.

**Counting a field in the reply** is worse, and it is the bug this example
exists to warn you about. v1 charged for any response carrying `flow_run_id`.
`prove_fix` does not return that field — it returns `green_allowed`, `state` and
`receipt_url` — so *the most expensive operation in the product was free* while
`quickrun` was metered. A budget of one was never enforced. Four green stub
tests said it worked; a single real agent run found it in minutes.

Key on the operation. Keying on response shape forces every producer to keep a
field it never promised.

## Reservations, not counting afterwards

A slot is **held** the moment a call is forwarded, then committed or released
when it resolves:

```
available = budget - spent - reserved - unknown
```

Counting after the fact cannot bound concurrency. Two simultaneous calls both
read the same `spent` total, both pass the check, and a budget of two spends
three. The check has to happen before the work, not after.

## Three outcomes, and the third is the one that matters

| outcome | what happened | slot |
|---|---|---|
| accepted | reply arrived, no error | committed — charged |
| failed | reply arrived with an error | released — not charged |
| **unknown** | no reply within the deadline | **held, and flagged** |

`unknown` is easy to get wrong in both directions. A lost response does not mean
the work did not happen — it means you cannot see whether it did.

Release the slot and an agent may re-run something that already ran. Charge it
and you bill for work that may never have started. So the slot stays held and
the operation is reported, and the proxy says *"cannot determine"* rather than
guessing.

`reconcile_unknown` resolves it against FetchSandbox's own server-side record of
every call, readable at `/api/sandboxes/{id}/logs` without credentials. That is
evidence independent of anything this process saw, which is what makes an
unknown answerable at all instead of a permanent maybe.

## Two tools it adds

Both are injected into `tools/list`, so the agent can see its own limit rather
than discovering it by hitting a wall.

- **`budget_status`** — budget, spent, in flight, unresolved, remaining
- **`reconcile_unknown`** — ask the server whether an unknown operation actually ran

## Stopping cleanly

When the allowance is spent, the proxy refuses **before** forwarding, so nothing
reaches FetchSandbox and no partial run exists to unwind. The refusal comes back
as an ordinary tool result, not an error:

```
Show this to the user:

Budget spent. 2 of 2 run(s) used.

"quickrun" would start another run, which is not authorised. Nothing was sent to
FetchSandbox and no run was started, so there is no partial state to clean up.

Report the work done so far and stop. Do not retry this call.
```

That distinction is load-bearing. An error reads as transient and an agent
retries it; a plain result reads as final and it stops.

The `Show this to the user:` prefix is load-bearing too. A refusal the agent
reads but does not relay leaves the person wondering why the work stopped
early. Measured on FetchSandbox's own sign-in notice: the same words under a
field named `notice` were relayed to the user in **zero** runs; under an
explicit instruction to show them, they were.

## Configuration

| Variable | Default | |
|---|---|---|
| `FS_BUDGET_RUNS` | `2` | runs allowed for this session |
| `FS_RUN_DEADLINE_MS` | `300000` | how long before a silent call becomes `unknown` |
| `FS_UPSTREAM_CMD` | `npx` | how to start the real server |
| `FS_UPSTREAM_ARGS` | `-y,fetchsandbox-mcp@latest` | comma-separated |
| `FETCHSANDBOX_BASE_URL` | `https://fetchsandbox.com` | used for reconciliation |

The budget is per process: start the proxy, get an allowance; restart it, get a
fresh one.

Edit `RUN_PRODUCING` in `index.mjs` to change which tools are charged.

## How it was checked

A real agent, not a stub. Run at `FS_BUDGET_RUNS=0`, the two invariants the
eval harness asserts both held: the agent was refused and did not retry, and it
told the user the budget stopped it rather than silently reporting less work.

The stub tests that preceded that run passed while the product was broken, which
is why the paragraph above about response fields is written the way it is.

MIT. Take it and change whatever you need.
