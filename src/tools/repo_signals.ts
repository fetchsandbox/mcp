/**
 * Client-side repo signals — the funnel's code-probe leg, run where the repo
 * actually is (the MCP server runs in the user's cwd; the backend can't see
 * their files). Mirrors backend/app/flows/repo_signals.py.
 *
 * Two layers:
 *   detected_specs — which providers the repo integrates (deps + env + imports).
 *   code_probe     — per provider, does its webhook handler carry each guard
 *                    (idempotency / signature / ordering), with a file:line.
 *
 * The backend router intersects the symptom's candidate specs with
 * detected_specs, and when several survive, the provider whose handler is
 * MISSING the relevant guard is the culprit — a fact from the code, not a guess.
 * Source stays on the machine: only this compact JSON travels.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const DEP_TO_SPEC: Record<string, string> = {
  stripe: "stripe",
  "@stripe/stripe-js": "stripe",
  "@paddle/paddle-node-sdk": "paddle",
  "@paddle/paddle-js": "paddle",
  "paddle-sdk": "paddle",
  "@clerk/nextjs": "clerk",
  "@clerk/express": "clerk",
  "@clerk/backend": "clerk",
  "@clerk/clerk-sdk-node": "clerk",
  "@descope/node-sdk": "descope",
  "@descope/web-js-sdk": "descope",
  descope: "descope",
  agentmail: "agentmail",
  resend: "resend",
};

const ENV_PREFIX_TO_SPEC: Record<string, string> = {
  STRIPE_: "stripe",
  PADDLE_: "paddle",
  CLERK_: "clerk",
  DESCOPE_: "descope",
  AGENTMAIL_: "agentmail",
  RESEND_: "resend",
};

// Code shapes that indicate a guard is PRESENT. Vocabulary of code, not prose.
const GUARD_SHAPES: Record<string, string[]> = {
  idempotency: [
    "processed_events", "processed_event", "already_processed", "seen_events",
    "idempotency", "idempotent", "dedupe", "dedup", "on conflict do nothing",
    "insert ignore", "setnx", "event_id",
  ],
  signature: [
    "constructevent", "verifysignature", "verify_signature", "unmarshal",
    "hmac", "createhmac", "compare_digest", "timingsafeequal",
  ],
  ordering: [
    "occurred_at", "event_timestamp", "updated_at >", "version >", "seq >",
    "if (ts <", "is_stale", "monotonic",
  ],
};

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rb"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "venv", ".venv",
  "__pycache__", "vendor", "target", "coverage", ".turbo",
]);
const MAX_FILES = 400;
const MAX_BYTES = 400_000;

export interface RepoSignals {
  detected_specs: string[];
  code_probe: Record<string, Record<string, { present: boolean; at?: string }>>;
}

function read(p: string): string {
  try {
    if (statSync(p).size > MAX_BYTES) return "";
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) break;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(full);
      } else if (CODE_EXT.has(name.slice(name.lastIndexOf(".")))) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Scan the repo for provider presence + per-provider guard presence. */
export function scanRepoSignals(cwd: string = process.cwd()): RepoSignals {
  const present = new Set<string>();
  const filesBySpec: Record<string, Set<string>> = {};

  // presence: manifests
  const pkg = join(cwd, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(read(pkg) || "{}");
      for (const grp of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(j[grp] || {})) {
          const spec = DEP_TO_SPEC[name];
          if (spec) present.add(spec);
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const req of ["requirements.txt", "pyproject.toml", "go.mod", "Gemfile"]) {
    const f = join(cwd, req);
    if (!existsSync(f)) continue;
    const text = read(f).toLowerCase();
    for (const [name, spec] of Object.entries(DEP_TO_SPEC)) {
      if (text.includes(name.toLowerCase())) present.add(spec);
    }
  }

  // presence: env files
  for (const name of [".env", ".env.example", ".env.sample", ".env.local", ".env.template"]) {
    const f = join(cwd, name);
    if (!existsSync(f)) continue;
    for (const line of read(f).split("\n")) {
      const key = line.split("=", 1)[0].trim().toUpperCase();
      for (const [prefix, spec] of Object.entries(ENV_PREFIX_TO_SPEC)) {
        if (key.startsWith(prefix)) present.add(spec);
      }
    }
  }

  // attribute code files to specs (import/require of the SDK, or a spec-named file)
  const specSet = new Set(Object.values(DEP_TO_SPEC));
  for (const file of walk(cwd)) {
    const rel = file.slice(cwd.length + 1);
    const low = read(file).toLowerCase();
    if (!low) continue;
    for (const [dep, spec] of Object.entries(DEP_TO_SPEC)) {
      if (low.includes(dep.toLowerCase())) {
        present.add(spec);
        (filesBySpec[spec] ||= new Set()).add(file);
      }
    }
    for (const spec of specSet) {
      if (rel.toLowerCase().includes(spec.split("-")[0])) {
        (filesBySpec[spec] ||= new Set()).add(file);
      }
    }
  }

  // probe: for each present spec, does its code carry each guard?
  const code_probe: RepoSignals["code_probe"] = {};
  for (const spec of present) {
    const files = [...(filesBySpec[spec] || [])];
    if (!files.length) continue;
    const guards: Record<string, { present: boolean; at?: string }> = {};
    for (const [guard, shapes] of Object.entries(GUARD_SHAPES)) {
      let at: string | undefined;
      for (const file of files) {
        const lines = read(file).toLowerCase().split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (shapes.some((s) => lines[i].includes(s))) {
            at = `${file.slice(cwd.length + 1)}:${i + 1}`;
            break;
          }
        }
        if (at) break;
      }
      guards[guard] = at ? { present: true, at } : { present: false };
    }
    code_probe[spec] = guards;
  }

  return { detected_specs: [...present].sort(), code_probe };
}
