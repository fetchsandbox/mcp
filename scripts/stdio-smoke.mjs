#!/usr/bin/env node
/**
 * Spawns the built MCP binary, runs the JSON-RPC handshake (initialize +
 * tools/list + tools/call import_spec), and prints what comes back.
 *
 * This validates the package end-to-end the way an actual IDE would
 * use it: stdin/stdout JSON-RPC, no HTTP.
 *
 *   node mcp/scripts/stdio-smoke.mjs
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASE = process.env.FETCHSANDBOX_BASE_URL || "https://stage.fetchsandbox.com";
const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "dist/index.js");

const proc = spawn("node", [BIN], {
  env: { ...process.env, FETCHSANDBOX_BASE_URL: BASE },
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk.toString()}`);
});

const buf = [];
proc.stdout.on("data", (chunk) => {
  buf.push(chunk);
});

let nextId = 1;
function send(method, params) {
  const msg = { jsonrpc: "2.0", id: nextId++, method, params };
  proc.stdin.write(JSON.stringify(msg) + "\n");
  return msg.id;
}

function notify(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

async function readResponse(forId) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const text = Buffer.concat(buf).toString();
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === forId) return msg;
      } catch {
        // partial frame
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no response for id=${forId}`);
}

async function main() {
  console.log(`▶ Spawning ${BIN} against ${BASE}`);

  // 1. initialize
  const initId = send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "stdio-smoke", version: "0.1.0" },
  });
  const init = await readResponse(initId);
  console.log(`✓ initialize — server: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`);

  notify("notifications/initialized");

  // 2. tools/list
  const listId = send("tools/list", {});
  const list = await readResponse(listId);
  const tools = list.result?.tools ?? [];
  console.log(`✓ tools/list — ${tools.length} tools`);
  for (const t of tools) console.log(`    • ${t.name} — ${t.description.slice(0, 80)}...`);

  // 3. tools/call import_spec with the petstore URL
  const callId = send("tools/call", {
    name: "import_spec",
    arguments: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
  });
  const call = await readResponse(callId);
  if (call.result?.isError) {
    console.log(`✗ tools/call import_spec FAILED: ${call.result.content?.[0]?.text}`);
  } else {
    const text = call.result?.content?.[0]?.text ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text.slice(0, 200) };
    }
    console.log(
      `✓ tools/call import_spec — spec_id=${parsed.spec_id} sandbox_id=${parsed.sandbox_id} workflows=${parsed.workflow_count} endpoints=${parsed.endpoint_count}`,
    );

    const firstWorkflow = parsed.workflows_preview?.[0]?.name ?? parsed.workflows?.[0]?.name;
    if (parsed.workflow_count > 0 && firstWorkflow) {
      // 4. tools/call run_workflow on the first workflow
      const runId = send("tools/call", {
        name: "run_workflow",
        arguments: {
          sandbox_id: parsed.sandbox_id,
          workflow_name: firstWorkflow,
        },
      });
      const run = await readResponse(runId);
      if (run.result?.isError) {
        console.log(`✗ tools/call run_workflow FAILED: ${run.result.content?.[0]?.text?.slice(0, 200)}`);
      } else {
        const rt = run.result?.content?.[0]?.text ?? "";
        let rp;
        try {
          rp = JSON.parse(rt);
        } catch {
          rp = { _raw: rt.slice(0, 200) };
        }
        console.log(`✓ tools/call run_workflow — status=${rp.status} steps=${(rp.steps || []).length}`);
      }
    }
  }

  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  proc.kill();
  process.exit(1);
});
