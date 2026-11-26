---
name: fs-validate
description: 'Investigate integration failures in existing application code and verify workflows through FetchSandbox. Use for reported delivery or state problems and requests to test, validate or prove an integration. Execute isolated application checks and report measured evidence. Separately supports explicitly requested provider-reference checks; those do not prove the application.'
---

# FetchSandbox: Validate Integration (conversational)

## Application verification branch

Use this branch when the user reports an integration failure in accessible app
code or asks whether their app works, including vague requests to investigate
what went wrong or to test and fix an app. It takes
precedence over the legacy reference-workflow procedure and confirmation gates
below. Do not require the literal word "validate."

Distinguish reproducing code behavior from attributing a particular customer
incident. Within the user's existing permissions, use an isolated synthetic
business fixture to test the suspected mechanism. A missing customer transaction
or message ID can block incident attribution without blocking that reproduction.
Honor explicit inspection-only limits. A proposed plan or provider reference is
not application reproduction: continue to execution, or identify the concrete
runtime, policy or observation blocker. If a repair is outside the request, show
the measured original behavior and ask whether to repair it; do not silently edit
the app or end with an indirect request for incident identifiers.

1. Inspect the real app, provider clients, entry points, persistence and existing
   webhook handlers. Identify every integrated provider from code; ask only when
   behavior or business policy remains ambiguous after inspection. Do not invent
   a known failure or ask the user to enumerate routine reliability tests.
2. For a narrow code-level failure, use the existing `prove_fix` path when its
   supported executor can run the original app and a proposed patch. Keep the
   original unchanged, inspect both execution results, and do not apply the patch
   before recording the original. A failed setup is not reproduction; retain it
   and use the managed application path when the executor cannot run this app.
   For a workflow rehearsal, if `plan_rehearsal` is available, start there with the
   user's goal and inspected application facts. The first response connects an
   owned test environment; follow
   its populated continuation in the same session to propose scenarios. Never
   ask the user for internal IDs, selectors, fixture JSON or provider slugs. Native
   apps use `manage_tunnel` for their actual running port; hosted apps use the
   disposable published origin. Without the guided tool, start a fresh
   `validate_integration` session for the inspected providers. Use returned
   application guidance, coverage policy and fault operation targets. Reference
   quickruns cannot replace application execution. Show the proposed rules,
   expected saved outcomes and unresolved business decisions in ordinary language.
   Start with a short summary of the critical scenarios, not the entire generated
   proposal. Ask one blocking policy question at a time after inspecting for facts
   the agent can discover. Keep the full proposal and coverage review available;
   a shorter presentation must not omit requirements or conceal unmeasured scope.
3. Prepare fixtures and read-only observation, configure the supported application
   suite, install temporary credentials through the protected handoff and preflight.
   Preserve the real provider protocol and business handlers. An observation
   adapter must not implement the behavior being tested or return a verdict.
   For a local Node app using native fetch, use the packaged
   `node_test_profile` returned by `install_test_credentials`: load its supplied
   preload with the ordinary app entry point and the protected dotenv file.
   Configure only the returned test provider bases and run ID. This header-only
   profile prevents another fetch wrapper from replacing the client. Do not put
   an observer in place of the app entry point. Read saved state through existing
   read endpoints, or an independent read-only datastore observer. This profile
   requires the supplied owner/CI `original_reference` when claiming an unchanged
   original: set the returned original-role environment variables, point the source
   root to that untouched project, and preserve its `FS_RUNTIME_BINDING` startup
   line for the exact run. Start the repaired app with the candidate role and
   preserve its startup line too. Without that reference, source identity remains
   unmeasured. The startup check does not make the filesystem immutable.
   This profile does not qualify other transports or establish remote source attestation.
   Observation may forward the declared run header, but must not add provider
   query parameters, enrich request/response bodies, replace clients, or change
   the original runtime's behavior. Source hashes alone do not attest an
   unchanged original if a wrapper transforms its network calls. Such a
   diagnostic must be labelled separately and cannot establish before/after proof.
   Applying the same normalization to both versions still changes the baseline.
   In particular, zero accepted provider effects after an observed business action
   can be an application failure. Record it and repair only the candidate; do not
   enrich the original request or response to make it match the incident story.
   Freeze each business rule as a distinct required check when it can be observed
   independently. The baseline must drive a real normal business action and assert
   its positive saved outcome, never just health or connectivity. Keep independent
   downstream effects as additional required checks so one failed effect does not
   unnecessarily prevent measuring other risks whose starting state still holds.
   Do not remove the failed effect or relax the baseline's real business outcome.
   Inspect existing provider records before declaring counts; select the tested
   business records using discovered attributes or recorded identities, not an
   arbitrary count over unrelated sample records. Freeze the same selectors and
   expected values BEFORE running either application version. Never add a filter,
   change a threshold or remove a check only on the fixed side. If the contract was
   invalid, retain that failed receipt, correct it explicitly, then run BOTH
   versions again under the corrected identical contract. Declare only real
   app-version/attempt/fixture bindings as different, not assertions or scenarios.
4. If planning is unavailable, use the returned `planning_recovery` instructions
   to author an executable candidate contract from inspected code. Keep the same
   session. A missing observer or an unarmed fault is a setup/execution gap, not
   evidence that the engine does not support it. Review relevant fault, concurrent
   event, ordering, response-loss and restart dimensions against actual capabilities.
5. Review the frozen target, app version, scenarios, expected saved outcomes,
   environment and observation windows before execution. Existing authorization
   for isolated testing covers routine setup; ask only for unresolved decisions
   or necessary access. Use `run_rehearsal` once and `get_rehearsal` for that exact
   attempt/job when available, otherwise use the existing validation continuation.
   Use `stop_rehearsal` only to cancel the exact attempt the user means. Never
   restart work after an uncertain submission. Follow any native restart checkpoint.
   Require independently recorded fault exposure plus saved application effects.
   When a check fails, repair the actual app and rerun the same assertions. Keep
   genuine capability gaps and missing evidence explicit; never drop checks for green.
6. Show a clearly labelled **Receipt** link for each reported scope, with its
   observed result and remaining gaps. Name a failed original as failed, a
   fixed-only run as fixed-only, and a modified-baseline experiment as diagnostic.
   Do not combine their facts into one before/after result. Retrieve the receipts
   independently. Clean up only this run's temporary settings and twins.

The request to test and fix already authorizes routine isolated preparation and
repairs. Ask the user for necessary native access or an unresolved policy, not for
repeated confirmation of the same work. For an explicitly requested provider-only
reference run, use the legacy procedure below and label its evidence accordingly.

## Output the user gets

**Console-only.** This skill writes NOTHING to the user's repo. All
output appears in the chat:

1. The workflow trace, step by step, with PASS/FAIL marks
2. The proof receipt — what was verified end-to-end
3. A shareable timeline URL `https://fetchsandbox.com/runs/<sandbox_id>`
   the user can drop in Slack or a PR comment
4. (When relevant) compliance notes from the spec's brain.yaml — the
   real-world gotchas they need to handle in their prod code

Why no file: the dev's repo should only contain code THEY wrote. Run
artifacts live in the FetchSandbox dashboard (the timeline URL).
Re-running this skill regenerates the trace — no state to commit.

## Prerequisite

The user must have the `fetchsandbox` MCP server installed. Check that
`mcp__fetchsandbox__*` tools are available. If not, tell them to install:

```
npx -y fetchsandbox-mcp
```

Then re-trigger.

## The principle — confirm before acting

This skill is conversational. There are exactly **three gates** at which
the skill STOPS and waits for the user:

| Gate | What's confirmed | Why |
|---|---|---|
| 1 | Intent (spec + scope) | Avoid running against the wrong API or wrong scope |
| 2 | Workflow selection (if filter matched 0 / many) | Avoid running 18 workflows when user wanted 2 |
| 3 | "What next" after results | User stays in control of follow-up |

Between gates, internal steps (spec resolution, batch run, result
streaming) happen automatically — those are mechanical, not decisions.
NO files are written to the user's repo at any point.

**Power-user mode**: when the user's initial prompt clearly specifies
spec + scope (e.g. "validate stripe checkout with fetchsandbox"), the
Gate 1 confirmation is a single-line ack — they can answer "y" in two
characters and proceed.

## Procedure

### Step 1 — Call `guide()` for deterministic routing

Call `mcp__fetchsandbox__guide` with the user's exact message as
`intent`. This is a stateless lookup; no side effects. It returns:

```
{
  spec: "stripe" | null,
  workflow: "accept_payment" | null,
  scenario: "payment_declined" | null,
  confidence: 0.0 - 1.0,
  reasoning: "…",
  matched_signals: ["spec:stripe", "workflow_default:accept_payment", …],
  next_question: { id, question, options[], default } | null
}
```

From the response, set:

- **`spec_target`** = `response.spec` (router-verified; if null, see fallback below)
- **`scope_hint`** = `response.workflow` (router-verified workflow id) OR any
  qualifier word the user said after the spec name (e.g. "checkout",
  "refunds") that survived the router. Null = all workflows.
- **`next_question`** = `response.next_question` (may be null)
- **`confidence`** = `response.confidence`

**Fallback (only if `confidence === 0` and `spec_target` is null)**: ASK
the user *"Which API do you want to validate? (Stripe, GitHub, Twilio,
Notion, … or paste a URL.)"* — STOP. When they reply, re-call `guide`
with their answer and re-run Step 1.

The router is the source of truth for spec/workflow. Do not silently
override it — if you disagree with its pick, raise it in Gate 1.

### Step 2 — GATE 1: confirm intent (now brain-aware)

**STOP. Do NOT call any other MCP tool yet.** The shape of this gate
depends on whether `next_question` was returned from `guide`:

**(2a) When `next_question` is null** (spec has no brain.yaml yet) —
send the legacy Gate 1 message:

```
Got it. About to validate:

  • Spec:  <spec_target>
  • Scope: <scope_hint or "all workflows">

Proceed? (y / n / or tell me what to change)
```

**(2b) When `next_question` is present** (spec has a brain.yaml — today:
stripe; soon: paddle/polar/resend/clerk/square) — fold the discovery
question into Gate 1 so the user answers it AT confirmation time, not
mid-run:

```
Got it. About to validate <spec_target> ({scope_hint or "all workflows"}).

```

**End Gate 1 with `AskUserQuestion` — NEVER prose "[1] / [2] / [3] / pick
a number" picker shorthand.** If `guide()` returned `next_questions[]`
plural, use multi-question form (tabs UX):

    AskUserQuestion(questions=[{
      header: "<≤12 chars chip>",
      question: "{next_question.question}",
      options: [
        {label: "{options[0].label}", description: "{infer from implies}"},
        {label: "{options[1].label}", description: "{infer from implies}"},
        ...,
        {label: "Use default ({next_question.default})",
         description: "Skip the picker — proceed with default"},
      ],
    }])

Then **WAIT for the picker selection:**

- If they pick a non-default option → record that option's `implies`
  block as run hints (`currency`, `three_ds`, `test_card_library`,
  `capture_method`, etc.) → continue to Step 3
- If they pick "Use default" → proceed with `next_question.default`
  (or just the resolved spec/workflow if no default) → continue to Step 3
- If they pick "Other" with free-text correction (e.g. *"all workflows"*)
  → update scope hint and re-render Gate 1
- If they dismiss/cancel → reply *"OK, paused. Tell me when you're
  ready."*, end the conversation

### Step 3 — Resolve the spec (internal, no gate)

Once intent is confirmed:

1. If the user gave a URL → call `mcp__fetchsandbox__import_spec(url=…)`
2. If they named a known API:
   - Call `mcp__fetchsandbox__list_specs(filter=<spec_target>)` to verify it's in the catalog
   - If exactly 1 match → use the vendor's public OpenAPI URL for
     `import_spec` (common URLs below)
   - If multiple matches → ASK the user: *"Found N matches: [list].
     Which one?"* — STOP, then continue
   - If zero matches → ASK: *"No catalogued spec for '<spec_target>'.
     Paste a public OpenAPI URL, or pick from these popular ones:
     [Stripe, GitHub, Twilio, Notion, OpenAI]"* — STOP

Common public OpenAPI URLs (use to skip a second round-trip):
- Stripe: `https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json`
- GitHub: `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json`

Capture from import response: `spec_id`, `sandbox_id`, `name`,
`workflow_count`, `workflows_preview`.

### Step 4 — GATE 2: confirm workflow scope

Filter workflows based on `scope_hint`:

- If `scope_hint` is null → all `workflow_count` workflows in scope, no
  filter needed. **Skip Gate 2** (intent was already "all workflows" and
  user already confirmed in Gate 1). Continue to Step 6.
- If `scope_hint` is set:
  1. Call `mcp__fetchsandbox__list_workflows(spec_id=<spec_id>)` to get
     the full list.
  2. Filter to workflows whose `id` OR `name` OR `description` contains
     `scope_hint` (case-insensitive substring).
  3. **Now gate based on match count**:

**If matched 1 workflow:**
**STOP. Send to user:**
```
Found 1 workflow matching '<scope_hint>':

  • <name> — <description>

Run it now? (y / show me all <workflow_count> instead)
```
WAIT for reply.

**If matched 2-5 workflows:**
**STOP. Send to user:**
```
Matched <N> workflows for '<scope_hint>':

  1. <name1>
  2. <name2>
  3. <name3>

Run all <N>? Or paste numbers to pick a subset. Or 'all' to run every workflow (<workflow_count>).
```
WAIT for reply.

**If matched 6+ workflows:**
**STOP. Send to user:**
```
Matched <N> workflows for '<scope_hint>' (showing first 5):

  1. <name1>
  2. <name2>
  3. <name3>
  4. <name4>
  5. <name5>
  … and <N-5> more

Run all <N>? Run just the first 5? Or paste a more specific scope.
```
WAIT for reply.

**If matched 0 workflows:**
**STOP. Send to user:**
```
No exact match for '<scope_hint>'. Three options:

  a. Run all <workflow_count> workflows (full coverage)
  b. List all <workflow_count> so you can pick
  c. Closest semantic match: <best_guess> — run just that

Which? (a / b / c)
```
WAIT for reply.

In all cases, the user's reply determines `final_workflow_names` (or
`null` to run all).

### Step 5 — Run (internal, no gate)

Call `mcp__fetchsandbox__run_all_workflows` ONCE with:
- `sandbox_id`
- `workflow_names` = the user's confirmed list (omit if "all")

**Do NOT loop `run_workflow` in singular form.** That tool is for
ad-hoc single-workflow execution and creates one IDE approval prompt per
workflow. `run_all_workflows` collapses everything to one approval.

If `run_all_workflows` is unavailable (very old MCP version), stop and
tell the user to upgrade: `npx -y fetchsandbox-mcp@latest`. Do NOT
silently fall back to a `run_workflow` loop.

### Step 6 — GATE 3: present results in chat + offer next step

After `run_all_workflows` returns, **stream the result directly to
chat**. NO file is written. Use the inline format below — concise
trace, then a one-line summary, then the next-step offer.

Per workflow, show:

```
✓ <workflow name> · <duration>ms · <steps_passed>/<steps_total> steps

  Step 1: <method> <path> → <response_status>
  Step 2: <method> <path> → <response_status>
  Step 3: <method> <path> → <response_status>
  Webhooks: <matched>/<expected> fired — <event type list>
```

Then the summary block:

```
✓ Validated <K>/<N> workflows of <spec name> (<scope_hint or "all">)
  • Duration: <X>s
  • Timeline: https://fetchsandbox.com/runs/<sandbox_id>  ← view full traces here

<if any failed>
Failed: <list of failed workflow names>
</if>

```

**End with `AskUserQuestion` — NEVER a "Reply with a number" prose prompt:**

    AskUserQuestion(questions=[{
      header: "Next move",
      question: "What's next?",
      options: [
        {label: "Validate a different scope on this spec",
         description: "I'll list the other workflows for this spec"},
        {label: "Validate a different API",
         description: "Switch to a different spec entirely (fs-explore to browse)"},
        {label: "Open the timeline in browser",
         description: "Inspect the full run trace at <timeline_url>"},
        {label: "We're done",
         description: "Close this validation thread"},
      ],
    }])

**Length discipline**: if the trace is long (>6 workflows or >20 steps
total), summarize the passing ones (`✓ <name> · all <N> steps passed`)
and ONLY expand failed ones. The timeline URL is the source of truth
for full request/response bodies — point users there for deep dives.

**Do NOT** redact bodies if you do print them inline — sandbox data is
fake. **Do NOT** write any file: the timeline URL is the artifact.

**STOP. Wait for user's reply.** Do not auto-start anything new. The
user is in control of follow-up. Common replies:

- `4` / `done` / `we're done` → reply *"Cool. Report at <path>."*, end
- `1` / *"validate refunds too"* → start Step 1 again with new `scope_hint`
- `2` / *"now do github"* → start Step 1 again with new `spec_target`
- `3` / *"open the timeline"* → reply *"Open: <timeline URL>"* — do not
  navigate; the user clicks

## If the user interrupts mid-flow

If the user says "stop", "pause", or denies an approval:
- Acknowledge in chat: *"Paused. The sandbox state is preserved on the
  FetchSandbox server — pick back up by re-triggering the skill, or
  view what ran so far at https://fetchsandbox.com/runs/<sandbox_id>."*
- Nothing on disk to clean up (this skill writes no files).

## Anti-patterns — DO NOT

- **Do NOT** call any MCP tool before the user has passed Gate 1
- **Do NOT** skip Gate 1, even when the user's initial prompt is
  unambiguous — the confirmation takes 2 seconds and prevents wrong-API
  runs
- **Do NOT** loop `run_workflow` to validate. Always use
  `run_all_workflows`. Looping is the bug we fixed in v0.2.0.
- **Do NOT** write any file to the user's repo. Console output only.
  The timeline URL is the artifact.
- **Do NOT** ignore the user's scope qualifier. "validate stripe
  checkout" ≠ "validate stripe".
- **Do NOT** invent fields the run response didn't return.
- **Do NOT** retry a failed workflow. First run is the truth.
- **Do NOT** auto-start a follow-up validation after Gate 3 unless the
  user explicitly asks for one.
- **Do NOT** commit the report. Write it, mention the path, let the
  user decide whether to commit.

## Why conversational

Without confirmation gates, a single mistyped spec name or scope word
costs the user a full 18-workflow run on the wrong target. With three
gates, the worst-case cost of a misunderstanding is one re-ask.

The agent is the user's assistant, not their autopilot. Decisions
stay with the user.
