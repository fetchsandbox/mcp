import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCodexPlugin } from "../scripts/codex-plugin.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fs-plugin-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = join(root, "stage"), output = join(root, "output"), skillSource = join(root, "SKILL.md");
  mkdirSync(join(stage, "server/dist"), { recursive: true });
  writeFileSync(join(stage, "server/dist/index.js"), "// frozen runtime\n");
  writeFileSync(join(stage, "server/package.json"), JSON.stringify({ version: "1.2.3", name: "fetchsandbox-mcp" }));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ version: "1.2.3", display_name: "FetchSandbox", long_description: "Recorded scope", author: { name: "FetchSandbox" }, homepage: "https://fetchsandbox.com", repository: { url: "https://github.com/fetchsandbox/mcp" }, license: "MIT" }));
  writeFileSync(skillSource, "---\nname: fs-validate\ndescription: Verify an existing application.\n---\n\n## Application verification branch\n\nInspect the real app.\n\n## Output the user gets\n\nLegacy menu.\n");
  return { root, stage, output, skillSource };
}

test("exports the frozen runtime and canonical application branch without a second tool registry", t => {
  const f = fixture(t); buildCodexPlugin(f);
  const plugin = join(f.output, "plugins/fetchsandbox");
  const metadata = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json")));
  assert.equal(metadata.version, "1.2.3");
  assert.equal(readFileSync(join(plugin, "server/dist/index.js"), "utf8"), readFileSync(join(f.stage, "server/dist/index.js"), "utf8"));
  const skill = readFileSync(join(plugin, "skills/fs-validate/SKILL.md"), "utf8");
  assert.match(skill, /Inspect the real app/); assert.doesNotMatch(skill, /Legacy menu/);
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json")));
  assert.deepEqual(mcp.mcpServers.fetchsandbox, { type: "stdio", command: "node", args: ["./server/dist/index.js"], cwd: ".",
    env_vars: ["FETCHSANDBOX_API_KEY", "FETCHSANDBOX_BASE_URL", "FETCHSANDBOX_WORKSPACE_ROOT"] });
  assert.equal(metadata.mcpServers, "./.mcp.json");
  const dependency = readFileSync(join(plugin, "skills/fs-validate/agents/openai.yaml"), "utf8");
  assert.match(dependency, /type: mcp\n      value: fetchsandbox/);
  assert.doesNotMatch(JSON.stringify(mcp), /:-|\$\{FETCHSANDBOX_API_KEY/);
  const evidence = JSON.parse(readFileSync(join(f.output, "build-evidence.json")));
  assert.match(evidence.runtime_sha256["server/dist/index.js"], /^[a-f0-9]{64}$/);
});

test("refuses version drift and incomplete canonical skill boundaries before replacing an artifact", t => {
  const f = fixture(t);
  writeFileSync(join(f.stage, "server/package.json"), '{"version":"9.0.0"}');
  assert.throws(() => buildCodexPlugin(f), /version or runtime/);
  writeFileSync(join(f.stage, "server/package.json"), '{"version":"1.2.3"}');
  writeFileSync(f.skillSource, "---\nname: fs-validate\n---\nUnreviewed format");
  assert.throws(() => buildCodexPlugin(f), /boundary changed/);
});

test("refuses embedded credential files and symlinks in the runtime stage", t => {
  const f = fixture(t);
  writeFileSync(join(f.stage, "server/.env"), "PRIVATE=must-not-ship");
  assert.throws(() => buildCodexPlugin(f), /Credential-bearing/);
  rmSync(join(f.stage, "server/.env"));
  symlinkSync(f.skillSource, join(f.stage, "server/escape"));
  assert.throws(() => buildCodexPlugin(f), /Symlinks/);
});

test("refuses overlapping stage and output paths", t => {
  const f = fixture(t);
  for (const output of [f.stage, join(f.stage, "nested"), f.root]) {
    assert.throws(() => buildCodexPlugin({ ...f, output }), /separate directories/);
  }
});

test("materializes npm executable links only when their targets stay inside the runtime", t => {
  const f = fixture(t);
  mkdirSync(join(f.stage, "server/node_modules/.bin"), { recursive: true });
  symlinkSync("../../dist/index.js", join(f.stage, "server/node_modules/.bin/runtime"));
  buildCodexPlugin(f);
  assert.equal(readFileSync(join(f.output, "plugins/fetchsandbox/server/node_modules/.bin/runtime"), "utf8"), "// frozen runtime\n");
});

test("the packaged launch command survives relocation without environment placeholder expansion", t => {
  const f = fixture(t);
  writeFileSync(join(f.stage, "server/dist/index.js"), 'process.stdout.write("frozen-runtime-started");\n');
  buildCodexPlugin(f);
  const installed = join(f.root, "different installed path");
  renameSync(join(f.output, "plugins/fetchsandbox"), installed);
  const config = JSON.parse(readFileSync(join(installed, ".mcp.json"))).mcpServers.fetchsandbox;
  // Match the measured native loader's package-relative cwd resolution. Do not
  // interpolate args: the older Codex loader passes them to Node literally.
  const result = spawnSync(config.command, config.args, {
    cwd: resolve(installed, config.cwd ?? "."), encoding: "utf8",
    env: { PATH: process.env.PATH }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "frozen-runtime-started");
});

test('public-mirror packaging uses the exported canonical skill and prefers the maintained source',async t=>{
 const {resolveCanonicalSkill}=await import('../scripts/codex-plugin.mjs');
 const root=mkdtempSync(join(tmpdir(),'fs-public-skill-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const mcp=join(root,'mcp');mkdirSync(mcp);
 assert.throws(()=>resolveCanonicalSkill(mcp),/Canonical application skill is missing/);
 const exported=join(mcp,'skills/fs-validate/SKILL.md');mkdirSync(join(mcp,'skills/fs-validate'),{recursive:true});writeFileSync(exported,'exported');
 assert.equal(resolveCanonicalSkill(mcp),exported);
 const maintained=join(root,'frontend/public/skills/fs-validate/SKILL.md');mkdirSync(join(root,'frontend/public/skills/fs-validate'),{recursive:true});writeFileSync(maintained,'maintained');
 assert.equal(resolveCanonicalSkill(mcp),maintained);
});
