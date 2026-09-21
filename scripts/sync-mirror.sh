#!/usr/bin/env bash
# Push this package to the PUBLIC mirror, github.com/fetchsandbox/mcp.
#
# The mirror is what humans read and what the directories index. Glama showed
# "3 tools" for five releases because the mirror sat at v0.1.1 — nothing was
# broken, it was just stale, and nothing told us.
#
# It COPIES A NAMED LIST rather than mirroring the directory. A blind copy of
# mcp/ deletes glama.json and .github/workflows/publish-registry.yml, which live
# only there — and the workflow is the only way we can publish to the official
# registry at all (the interactive login cannot do an org namespace).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# server.json carries the version TWICE: once at the top level, and once at
# packages[].version — and it is the NESTED one the registry uses to resolve
# which npm package a client installs. Nothing kept them in step, so the nested
# field sat at 0.5.3 while we shipped 0.5.4, 0.5.5 and 0.5.6. The registry
# dutifully told every client to install 0.5.3, for three consecutive releases.
# Nothing failed. The listing looked current, because the version people SEE is
# the top-level one.
#
# (Found on 2026-09-18 by our own find_bugs, pointed at the public mirror.)
#
# The mirror repo's publish-registry.yml compares only the top-level field, so
# it cannot catch this. Rather than add a second check that must be remembered,
# package.json is made the single source: every version in server.json is
# rewritten from it here, before anything is copied.
node -e '
  const fs = require("fs");
  const f = process.argv[1], v = process.argv[2];
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const was = [d.version, ...(d.packages || []).map(p => p.version)];
  d.version = v;
  for (const p of d.packages || []) p.version = v;
  const now = [d.version, ...(d.packages || []).map(p => p.version)];
  if (was.join() !== now.join()) {
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
    console.log(`  server.json versions realigned to ${v} (were ${was.join(", ")})`);
  }
' "$SRC/server.json" "$VERSION"

# Everything the published package is built from. dist/ is not here on purpose:
# the mirror is source, and npm builds from it.
# `examples/` is here because it was NOT, and the budget proxy sat in the
# private repo for a day while being described to the person who asked for it.
# Anything a user is told to look at must be on the mirror, or the link is a 404.
PATHS=(src test scripts examples package.json package-lock.json server.json
       tsconfig.json README.md LICENSE glama.json)

echo "syncing fetchsandbox-mcp $VERSION to the public mirror"
git clone -q --depth 1 "https://github.com/fetchsandbox/mcp.git" "$WORK/mirror"

for p in "${PATHS[@]}"; do
  [ -e "$SRC/$p" ] || { echo "  missing locally, skipped: $p"; continue; }
  rm -rf "${WORK:?}/mirror/$p"
  cp -R "$SRC/$p" "$WORK/mirror/$p"
done

cd "$WORK/mirror"
if git diff --quiet && git diff --cached --quiet; then
  echo "  mirror already matches $VERSION — nothing to push"
  exit 0
fi
git add -A
git -c user.name="Raj Nagulapalle" -c user.email="raj@fetchsandbox.com" \
    commit -q -m "release $VERSION"
git push -q origin HEAD
echo "  pushed. tag it to publish to the official registry:"
echo "    gh release create v$VERSION --repo fetchsandbox/mcp --generate-notes"
