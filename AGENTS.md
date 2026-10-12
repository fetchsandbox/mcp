# MCP release instructions

For an authorized MCP release, follow the existing distribution procedure in
`../docs/mcp-distribution-checklist.md` when working in the sandbox repository.
These requirements also apply to the public mirror:

1. Build and run the existing MCP tests. Use committed source and exclude secrets
   and unrelated local changes. Keep package.json, server.json and its nested npm
   package version aligned. Do not republish an existing npm version.
2. Publish npm, verify the served version, and run `scripts/sync-mirror.sh` from
   that same verified source. Preserve the mirror's registry workflow.
3. Publish through the existing `publish-registry.yml` workflow and verify both
   the official registry version and nested npm version. A successful dispatch
   alone is not proof of publication.
4. Smithery is a frozen bundle, not an automatic npm update. For EVERY release,
   run `npm run mcpb`, inspect the packed manifest version, authentication text,
   tool input schemas and annotations, then start the unpacked bundle and call
   MCP initialize/tools/list. Confirm its JavaScript matches the npm artifact.
   Publish with `smithery mcp publish ./fetchsandbox-mcp.mcpb -n fetchsandbox/mcp`.
   Verify SUCCESS, the new deployment/bundle ID, and the actual public tool list.
   Derive expected tools from the running bundle; do not freeze a tool count.
   Local and hosted transports intentionally have different advertised tool sets.
5. Glama: Sync Server under Repository, verify the fetched commit, then Build &
   Release under Dockerfile. Verify the actual test result and released version.
   Record external builder failures as blocked, never as a passed release.
6. Check other directories individually. Preserve existing submission workflows;
   do not infer freshness from npm or the official registry alone.

Keep API keys optional for startup/discovery, while describing authentication
requirements for application planning, verification and managed local tunnels.
Never upload real keys or dummy keys pretending to authenticate. Preserve the
existing bundle builder and its inputSchema/annotation compatibility handling.

Cached API responses may lag the public page. Check the page and a fresh read
before concluding that publishing failed; never blindly republish a duplicate.
Save per-surface version, revision/deployment ID, URL, test outcome and blocker.
The final update must distinguish verified, pending and blocked surfaces.
