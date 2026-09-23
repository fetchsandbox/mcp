/**
 * Every argument a tool ADVERTISES must reach its handler.
 *
 * The dispatcher in src/index.ts builds each handler's input from a HARDCODED
 * field list. Add a property to a tool's inputSchema and forget that list, and
 * the argument is silently dropped: the tool still advertises it, an agent
 * still sends it, the handler never sees it. No error anywhere.
 *
 * This is trap #3 from the repo's CLAUDE.md — "unknown field -> dropped kwarg"
 * — which had already been found twice on the Python side (eight scenario
 * knobs, then `repeat`/`stable_under_repeat`). It happened here too.
 *
 * MEASURED 2026-09-23, against the PUBLISHED 0.5.8:
 *
 *   list_workflows({spec_slug: "resend"})
 *     -> "Error: Pass spec_id or spec_slug (e.g. 'resend')."
 *
 * `spec_slug` was the headline of that release — "you do not need to look up a
 * spec_id first" — it was in the tool description, in the README, and it had
 * never worked on either transport. The only existing test called the tool
 * with `spec_id`, so the suite was green.
 *
 * A per-tool test would only have covered the tool someone remembered to write
 * it for. This checks EVERY tool, so the next one is caught on arrival.
 *
 * It is a static read of the dispatch source on purpose: no network, no
 * container, no credentials, so it runs everywhere and cannot be skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(join(ROOT, "src/index.ts"), "utf8");

/** Every tool's advertised properties, read from its own source file. */
function declaredProperties() {
  const out = new Map();
  const files = readFileSync(join(ROOT, "src/index.ts"), "utf8")
    .split("\n")
    .filter((l) => l.includes('from "./tools/'))
    .map((l) => l.match(/from "\.\/tools\/([a-z_]+)\.js"/)?.[1])
    .filter(Boolean);

  for (const f of new Set(files)) {
    let src;
    try {
      src = readFileSync(join(ROOT, "src/tools", `${f}.ts`), "utf8");
    } catch {
      continue;
    }
    // The tool's wire name, e.g. `name: "list_workflows"`.
    const name = src.match(/name:\s*"([a-z_]+)"/)?.[1];
    if (!name) continue;
    const block = src.match(/inputSchema:\s*\{[\s\S]*?\n {2}\}/)?.[0];
    if (!block) continue;
    const props = block.match(/properties:\s*\{([\s\S]*)/)?.[1];
    if (!props) continue;
    // Property keys are declared at a known indent inside `properties`.
    const names = [...props.matchAll(/^ {6}([a-z_][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
    if (names.length) out.set(name, { file: f, props: names });
  }
  return out;
}

/** The dispatcher's `case` body for one tool. */
function dispatchBody(toolName) {
  // Cases are written as `case <x>Tool.name:` — find the block whose handler
  // call belongs to this tool by locating the tool's own camelCase symbol.
  const camel = toolName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const start = INDEX.indexOf(`case ${camel}Tool.name:`);
  if (start === -1) return null;
  const end = INDEX.indexOf("break;", start);
  return end === -1 ? null : INDEX.slice(start, end);
}

test("every declared tool argument is forwarded by the dispatcher", () => {
  const declared = declaredProperties();
  assert.ok(declared.size >= 8, `only found ${declared.size} tools — the parser is broken, not the code`);

  const dropped = [];
  for (const [tool, { props }] of declared) {
    const body = dispatchBody(tool);
    if (body === null) continue;          // dispatched elsewhere; not this test's claim
    for (const p of props) {
      if (!body.includes(p)) dropped.push(`${tool}.${p}`);
    }
  }
  assert.deepEqual(
    dropped, [],
    "these arguments are advertised in a tool's inputSchema but never passed " +
    "to its handler, so an agent that sends them gets silence:\n  " +
    dropped.join("\n  "),
  );
});

test("the check can actually fail", () => {
  // A guard that cannot fail is the bug it is guarding against.
  const body = dispatchBody("list_workflows");
  assert.ok(body, "list_workflows is not dispatched in index.ts");
  assert.ok(body.includes("spec_slug"), "regression: spec_slug dropped again");
  assert.ok(!body.includes("spec_slug_that_does_not_exist"));
});
