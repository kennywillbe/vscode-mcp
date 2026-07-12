# Changelog

All notable changes to `vscode-mcp` are documented here. The project uses Semantic
Versioning for its public release artifacts.

## 1.0.1 — 2026-07-12

- Fixed a VS Code 1.101 lifecycle race that could leave an explicitly enabled workspace
  temporarily ineligible and undiscoverable during first activation.
- Added bounded, observation-only enable retries that preserve concurrent disable,
  workspace-identity changes, and fail-closed authorization behavior.
- Added bounded listener-start retries with complete per-attempt cleanup and safe
  startup-stage diagnostics.
- Added deterministic regression coverage for transient startup failures, persistent
  failure bounds, shutdown races, and packaged Extension Host discovery.

## 1.0.0 — 2026-07-12

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
- Added one-command MCP client setup, repair, and removal. The VSIX carries the exact
  server bundle; setup verifies its SHA-256, discovers Node.js 22 without a shell, and
  can atomically manage a previewed, backed-up Codex TOML block or copy generic JSON.
- Added a no-telemetry security baseline and fail-closed handling for unsupported,
  untrusted, remote, virtual, malformed, stale, or unauthenticated inputs.
- Hardened provider and editor output handling with numeric-index raw/nested collection
  budgets, safe omission accounting, depth/cycle limits, and cap-plus-one regressions.
- Split prompt client cancellation/timeout from actual execution settlement so
  non-cancellable VS Code work continues consuming the four/eight admission limits until
  its original promise settles.

Version 1.0 targets standard local VS Code Desktop on macOS and Linux. Windows is a
post-1.0 roadmap item and fails closed before IPC publication.
