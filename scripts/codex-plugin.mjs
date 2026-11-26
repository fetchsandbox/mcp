/** Package the existing MCPB stage; no second server, dependency install or tool registry. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export function resolveCanonicalSkill(root) {
  const maintained = join(root, "../frontend/public/skills/fs-validate/SKILL.md");
  const exported = join(root, "skills/fs-validate/SKILL.md");
  if (existsSync(maintained)) return maintained;
  if (existsSync(exported)) return exported;
  throw new Error("Canonical application skill is missing; sync the maintained skill before packaging");
}

export function buildCodexPlugin({ stage, output, skillSource }) {
  stage = realpathSync(stage);
  output = join(realpathSync(dirname(resolve(output))), basename(output));
  if (stage === output || !relative(stage, output).startsWith("..") || !relative(output, stage).startsWith("..")) {
    throw new Error("Plugin output and MCPB stage must be separate directories");
  }
  const bundle = json(join(stage, "manifest.json"));
  const pkg = json(join(stage, "server/package.json"));
  if (bundle.version !== pkg.version || !existsSync(join(stage, "server/dist/index.js"))) {
    throw new Error("MCPB stage version or runtime is inconsistent");
  }
  const source = readFileSync(skillSource, "utf8");
  const header = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const start = source.indexOf("## Application verification branch");
  const end = source.indexOf("## Output the user gets", start);
  if (!header || start < 0 || end <= start) throw new Error("Canonical application skill boundary changed; review before packaging");
  // Export the maintained application branch, excluding the legacy reference-only
  // confirmation menus and Claude-specific AskUserQuestion instructions.
  const skill = header[0] + "\n" + source.slice(start, end).trim() + "\n";
  const hashes = {};
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) {
        const target = realpathSync(path);
        if (relative(join(stage, "server"), target).startsWith("..") || !statSync(target).isFile()) {
          throw new Error("Symlinks must resolve to a file inside the staged runtime");
        }
      }
      if (entry.isDirectory()) inspect(path);
      else {
        if ([".env", ".npmrc", "credentials.json", "auth.json"].includes(entry.name)) throw new Error("Credential-bearing file in runtime stage");
        const rel = relative(stage, path);
        if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Runtime escaped stage");
        hashes[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  }
  inspect(join(stage, "server"));
  rmSync(output, { recursive: true, force: true });
  const plugin = join(output, "plugins/fetchsandbox");
  mkdirSync(join(plugin, "skills/fs-validate/agents"), { recursive: true });
  cpSync(join(stage, "server"), join(plugin, "server"), { recursive: true, dereference: true });
  writeFileSync(join(plugin, "skills/fs-validate/SKILL.md"), skill);
  writeFileSync(join(plugin, "skills/fs-validate/agents/openai.yaml"), "policy:\n  allow_implicit_invocation: true\ndependencies:\n  tools:\n    - type: mcp\n      value: fetchsandbox\n");
  mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
  writeJSON(join(plugin, ".codex-plugin/plugin.json"), {
    name: "fetchsandbox", version: pkg.version, description: bundle.long_description,
    author: bundle.author, homepage: bundle.homepage,
    repository: bundle.repository.url, license: bundle.license,
    skills: "./skills/", mcpServers: "./.mcp.json",
    requires_local_executor: true, interface: { displayName: bundle.display_name },
  });
  // Codex compatibility configuration forwards the existing private environment.
  // Portable MCP env values are literal in the tested Codex runtime; never put
  // credential placeholders there or embed a key in the installed package.
  writeJSON(join(plugin, ".mcp.json"), {
    // Legacy Codex plugin loaders resolve cwd relative to the installed package,
    // but do not expand PLUGIN_ROOT in args. Relative cwd keeps the frozen server
    // relocatable without relying on shell expansion or a machine-specific path.
    mcpServers: { fetchsandbox: { type: "stdio", command: "node", args: ["./server/dist/index.js"], cwd: ".",
      env_vars: ["FETCHSANDBOX_API_KEY", "FETCHSANDBOX_BASE_URL", "FETCHSANDBOX_WORKSPACE_ROOT"] } },
  });
  mkdirSync(join(output, ".agents/plugins"), { recursive: true });
  writeJSON(join(output, ".agents/plugins/marketplace.json"), {
    name: "fetchsandbox-local", interface: { displayName: "FetchSandbox" },
    plugins: [{ name: "fetchsandbox", source: { source: "local", path: "./plugins/fetchsandbox" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Developer Tools" }],
  });
  writeJSON(join(output, "build-evidence.json"), {
    scope: "local desktop packaging, not public publication or application proof",
    version: pkg.version, runtime_sha256: hashes,
    canonical_skill_sha256: createHash("sha256").update(source).digest("hex"),
    packaged_skill_sha256: createHash("sha256").update(skill).digest("hex"),
  });
  return output;
}
