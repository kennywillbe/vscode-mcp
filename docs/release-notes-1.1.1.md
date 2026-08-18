# vscode-mcp 1.1.1 release notes

Version 1.1.1 is a coordinated extension/server security and maintenance patch. It does
not add or remove MCP tools and does not change the `vscode-mcp.tools/1.0.0` or internal
IPC contracts.

## Security fixes

- Visual change tracking now checks the remaining 2 MiB per-file and 32 MiB aggregate
  snapshot budgets before materializing a live document's complete text. Oversized
  documents still receive bounded change markers, but no before-snapshot is retained.
- Configured task startup rechecks the execution-grant generation after VS Code returns
  the execution handle and terminates a late handle when access was revoked.
- Named debug startup tracks pending sessions across revocation and stops a matching
  late session instead of allowing it to continue outside the active grant.
- Language, formatting, edit, and task provider results now cross raw item and byte
  ceilings before mapping, sorting, fingerprinting, or recursive projection. Generic
  provider objects expose only an explicit safe field set, and code-action edit previews
  are not prepared without a current write grant.
- Fragmented newline-delimited MCP input now uses one fixed-capacity bounded buffer, so
  accepted bytes are copied linearly rather than repeatedly concatenating the complete
  partial message.
- The locked dependency graph was refreshed to patched transitive versions. `pnpm audit`
  reports no known vulnerabilities for the release snapshot.

## Maintenance

- Updated `@modelcontextprotocol/sdk` to 1.30.0 and refreshed compatible development
  tooling without raising the supported Node.js 22 or VS Code 1.101 minimums.
- Updated pinned GitHub Actions to current reviewed commit SHAs and moved CI to the
  current Node.js 22 security patch.
- Added deterministic regression tests for snapshot allocation, task/debug revocation
  races, and maximally fragmented bounded stdio input.

## Upgrade

Use the 1.1.1 extension and server together. Marketplace users receive the bundled
server through **VS Code MCP: Set Up MCP Client**; manual users should replace both the
VSIX and server archive from the same checksummed GitHub Release. Restart Codex after
repairing or reinstalling the client configuration.

The supported runtime remains local VS Code Desktop 1.101 or newer on macOS and Linux
with Node.js 22.13 or newer. Windows, remote extension hosts, virtual workspaces, Snap,
and Flatpak remain unsupported and fail closed where applicable.
