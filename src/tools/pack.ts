/**
 * Pack the caller's working directory into a base64 .tar.gz to ship to the
 * FetchSandbox backend (which relays it to the FS behavioral runtime).
 *
 * Uses the system `tar` (present on macOS, Linux, and Windows 10+ as bsdtar)
 * to avoid adding an npm dependency to the npx footprint. Vendored/VCS dirs and
 * macOS AppleDouble (`._*`) files are excluded; COPYFILE_DISABLE stops macOS
 * tar from generating AppleDouble entries in the first place.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolError } from "../client.js";

// Mirrors the backend's _TAR_EXCLUDE plus common build/output dirs.
const EXCLUDES = [
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  ".next",
  ".turbo",
  "build",
  "coverage",
  ".DS_Store",

  // AGENT INSTRUCTION FILES ARE NEVER SHIPPED.
  //
  // The analysis runtime runs its agent with cwd set to the unpacked
  // workspace, and Claude Code auto-loads CLAUDE.md from cwd. Any instruction
  // file in a repo therefore becomes instructions to an agent with a different
  // toolset and a different job.
  //
  // Measured 2026-09-07: a CLAUDE.md reading "bug fixes go through
  // FetchSandbox — guide → find_bugs → ..." made the find_bugs agent try to
  // call tools it does not have, report them as denied, ask the USER to edit
  // .claude/settings.local.json, and fall back to a static read; the fix_bug
  // agent read "do not hand-write a fix" and produced no changes. Two tools
  // down, from one file, and both looked like independent breakage.
  //
  // THIS LIST IS THE ONE THAT MATTERS for an agent-initiated call: the client
  // builds the tar on the user's machine, so excluding it server-side would
  // not have helped. A repo's instructions are not source under analysis.
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENT.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".aiderrules",
  ".claude",
  ".cursor",
  ".windsurf",
  "copilot-instructions.md",
];

// nginx allows 50m on the probe endpoints; stay under with headroom.
const MAX_TAR_BYTES = 40 * 1024 * 1024;

/** Tar+gzip `dir`, return base64. Throws ToolError with a readable message. */
export function packDirToBase64(dir: string): { b64: string; bytes: number } {
  const tmp = mkdtempSync(join(tmpdir(), "fs-pack-"));
  const tarPath = join(tmp, "ws.tar.gz");
  try {
    // --exclude flags must precede the path list. `--exclude=X` prunes any dir
    // named X at any depth in both GNU tar and bsdtar.
    const args = ["-czf", tarPath, "-C", dir];
    for (const e of EXCLUDES) args.push(`--exclude=${e}`);
    args.push("--exclude=._*", ".");
    try {
      execFileSync("tar", args, {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
      throw new ToolError(
        `Could not package the project with 'tar': ${stderr || (e as Error).message}`,
      );
    }
    const buf = readFileSync(tarPath);
    if (buf.length > MAX_TAR_BYTES) {
      throw new ToolError(
        `Project is ${(buf.length / 1048576).toFixed(1)}MB packed, over the ` +
          `${MAX_TAR_BYTES / 1048576}MB limit. Run from a smaller directory, or ` +
          `add large folders to .gitignore-style excludes.`,
      );
    }
    return { b64: buf.toString("base64"), bytes: buf.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
