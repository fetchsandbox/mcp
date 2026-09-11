// Single source of truth for the package version — read from package.json at
// runtime so the banner / user-agent can never drift from what npm published.
// (A hardcoded constant went stale once: 0.3.12 shipped but printed "0.3.11".)
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

let v = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  v = pkg.version || v;
} catch {
  /* fall back to 0.0.0 if the manifest can't be read */
}

export const VERSION: string = v;
