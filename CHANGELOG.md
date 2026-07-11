# Changelog

All notable changes to `vscode-mcp` are documented here. The project uses Semantic
Versioning for its public release artifacts.

## 1.0.0 — unreleased candidate work

- Added an authenticated, versioned, user-scoped local bridge between MCP `stdio` and
  explicitly enabled VS Code Desktop workspaces.
- Added deterministic discovery and selection for multiple VS Code windows.
- Added the complete 39-tool MCP surface: live editor context; bounded repository
  discovery, batch reads, and dirty-buffer-aware literal search; structured language
  intelligence; controlled multi-document/file/provider writes; configured tasks; and
  named run/debug configurations.
- Added independent visible, memory-only write and execution grants with generation
  invalidation, immediate revoke controls, and lifecycle teardown.
- Added non-overwriting file lifecycle operations, stale/overlap-safe text commits,
  semantic rename, formatting, and single-use code-action previews without provider
  command execution.
- Added canonical realpath workspace isolation, dirty-buffer support, provider-result
  filtering, cancellation, deadlines, concurrency limits, and explicit truncation.
- Added release tooling for a Marketplace-ready VSIX and bundled GitHub server archive
  with checksums, licenses, notices, an SBOM, and installation documentation. The exact
  VSIX is shared between the GitHub Release and Marketplace; deterministic rebuild and
  packaged-pair acceptance are release gates.
- Added a no-telemetry security baseline and fail-closed handling for unsupported,
  untrusted, remote, virtual, malformed, stale, or unauthenticated inputs.
- Hardened provider and editor output handling with numeric-index raw/nested collection
  budgets, safe omission accounting, depth/cycle limits, and cap-plus-one regressions.
- Split prompt client cancellation/timeout from actual execution settlement so
  non-cancellable VS Code work continues consuming the four/eight admission limits until
  its original promise settles.

Version 1.0 targets standard local VS Code Desktop on macOS and Linux. Windows is a
post-1.0 roadmap item and fails closed before IPC publication. No remote repository or
artifact has been published.
