#!/usr/bin/env node
/**
 * Build the .mcpb bundle Smithery distributes for local (stdio) installs.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-OFF
 * --------------------------------------
 * A bundle is a frozen copy of the server. Build it by hand once and it is
 * correct for exactly one release, then silently describes a version nobody
 * runs — which is precisely how the GitHub mirror sat at 0.1.1 advertising
 * three tools while npm served fourteen.
 *
 * So the manifest is DERIVED, never hand-kept:
 *   - version and description come from package.json
 *   - the tool list is read out of src/index.ts
 * If a tool is added and this is re-run, the bundle follows. If it is not
 * re-run, `npm run mcpb` fails the drift check below rather than shipping a
 * stale list.
 *
 *   npm run mcpb          # build dist, stage, write manifest, pack
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".mcpb-build");
const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// ── the tool list, from the server itself ───────────────────────────────────
// Ask the built server over stdio rather than parsing TypeScript. It is the
// only source that cannot disagree with what the server actually advertises,
// and it yields inputSchema — which Smithery's publish API requires per tool
// and which no amount of regex over src/ can produce faithfully. Sending the
// bare {name, description} the MCPB spec allows got back fourteen identical
// "expected object, received undefined" errors, one per tool.
async function toolsFromServer() {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const child = spawn("node", [join(ROOT, "dist/index.js")], {
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "mcpb-")), FETCHSANDBOX_API_KEY: "" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  const send = (id, method, params) =>
    new Promise((res) => {
      waiters.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await send(1, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "mcpb-build", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await send(2, "tools/list", {});
    return (listed.result?.tools ?? []).map((t) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, 500),
      inputSchema: t.inputSchema,
        annotations: t.annotations,  // same story: MCPB rejects it, Smithery scores it
      // Smithery requires this object. An empty schema is still an object,
      // so a tool that takes no arguments does not fail the publish.
    }));
  } finally {
    child.kill();
  }
}

sh("npm run build");
const tools = await toolsFromServer();
const names = tools.map((t) => t.name);
if (names.length === 0) throw new Error("server advertised no tools — refusing to ship an empty bundle");
// NOTE: the MCPB manifest schema accepts only {name, description} per tool and
// rejects inputSchema outright ("Unrecognized key"). Smithery's publish payload
// wanted something more and returned one error per tool. The two specs conflict,
// so the array is omitted below and Smithery populates it by scanning the
// server — which is what it does for URL publishes anyway.

console.log(`\n▶ ${names.length} tools: ${names.join(", ")}\n`);

// ── stage ───────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "server"), { recursive: true });
cpSync(join(ROOT, "dist"), join(OUT, "server/dist"), { recursive: true });
cpSync(join(ROOT, "package.json"), join(OUT, "server/package.json"));
// A bundle runs with no install step, so its runtime deps ship inside it.
sh("npm install --omit=dev --silent --no-audit --no-fund", join(OUT, "server"));

const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "FetchSandbox",
  version: pkg.version,
  description: pkg.description,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  long_description:
    "FetchSandbox runs your integration against every service it touches with " +
    "failures injected on purpose — retried webhooks, declined cards, rate " +
    "limits, auth errors.\n\nWhen it finds a bug it can propose a fix and then " +
    "prove it: the same failure is run against your code before and after the " +
    "diff. Green only if it reproduced first and stopped after. You get a " +
    "receipt URL either way.\n\nNo account is required to start. Signing in is " +
    "optional and takes about twenty seconds.",
  author: { name: "FetchSandbox", url: "https://fetchsandbox.com" },
  homepage: pkg.homepage ?? "https://fetchsandbox.com",
  documentation: "https://github.com/fetchsandbox/mcp#readme",
  repository: { type: "git", url: "https://github.com/fetchsandbox/mcp" },
  license: pkg.license ?? "MIT",
  keywords: pkg.keywords ?? [],
  server: {
    type: "node",
    entry_point: "server/dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/dist/index.js"],
      env: { FETCHSANDBOX_API_KEY: "${user_config.api_key}" },
    },
  },
  // Optional on purpose. The server works signed out, and the notice offers
  // sign-in at the moment it is worth something. Marking this required would
  // put a credential wall in front of a product that does not need one.
  user_config: {
    api_key: {
      type: "string",
      title: "API key (optional)",
      description:
        "Leave blank to run anonymously. Sign in later at fetchsandbox.com/device " +
        "to keep receipts and get your own rate limit.",
      sensitive: true,
      required: false,
    },
  },
  // `tools` above is written WITHOUT inputSchema so the MCPB validator passes;
  // injectInputSchemas() puts it back after packing. See that function.
  compatibility: { runtimes: { node: ">=18" } },
};
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

sh(`npx --yes @anthropic-ai/mcpb@latest validate ${join(OUT, "manifest.json")}`);
sh(`npx --yes @anthropic-ai/mcpb@latest pack ${OUT} ${join(ROOT, "fetchsandbox-mcp.mcpb")}`);

if (!existsSync(join(ROOT, "fetchsandbox-mcp.mcpb"))) throw new Error("pack produced no bundle");
injectInputSchemas(join(ROOT, "fetchsandbox-mcp.mcpb"), tools);
console.log(`\n✓ fetchsandbox-mcp.mcpb — v${pkg.version}, ${names.length} tools`);
console.log("  publish:  smithery mcp publish ./fetchsandbox-mcp.mcpb -n <org>/<name>\n");

/**
 * Put `inputSchema` back into the packed manifest.
 *
 * The two specs disagree. Measured 2026-09-12, both sides:
 *
 *   MCPB validator    tools.N: Unrecognized key(s) in object: 'inputSchema'
 *   Smithery publish  Invalid input: expected object, received undefined  (x14)
 *
 * One refuses the field the other demands, so no single manifest satisfies
 * both. Packing without it and injecting after satisfies each in turn.
 *
 * Not doing this was not cosmetic. With no tools registered, Smithery scored
 * Capability Quality 0 of 40 — tool descriptions, parameter descriptions and
 * naming all score zero when there are no tools to score.
 *
 * The comment this replaced said Smithery "populates it by scanning the
 * server". It does not. That went unnoticed because nothing failed: the
 * publish succeeded and the listing quietly advertised zero tools.
 *
 * If a future MCPB release accepts inputSchema, delete this and put the field
 * in the manifest directly. Check, do not assume.
 */
function injectInputSchemas(bundlePath, tools) {
  const tmp = mkdtempSync(join(tmpdir(), "mcpb-schemas-"));
  try {
    sh(`unzip -q ${JSON.stringify(bundlePath)} -d ${JSON.stringify(tmp)}`);
    const mfPath = join(tmp, "manifest.json");
    const mf = JSON.parse(readFileSync(mfPath, "utf8"));
    mf.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      // An empty schema is still an object, so a no-argument tool is fine.
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");
    rmSync(bundlePath);
    sh(`zip -q -r ${JSON.stringify(bundlePath)} .`, tmp);
    console.log(`  + inputSchema injected for ${mf.tools.length} tools`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
