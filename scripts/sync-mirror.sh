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
