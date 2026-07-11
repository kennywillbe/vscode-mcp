# vscode-mcp 1.0.0 release notes

Version 1.0.0 is the planned first public version of `vscode-mcp`. This draft describes
the validated local release candidate; nothing has been published. The implementation
connects an MCP client to live VS Code Desktop IDE capabilities through a local,
authenticated bridge. The extension and server are two version-matched parts of one
release and must be installed together.

## Included tools

The frozen contract contains 39 tools: instance/editor orientation; bounded file
discovery, multi-document read, and dirty-buffer-aware literal search; diagnostics and
the complete structured language-intelligence set; version-checked multi-document
editing, controlled file lifecycle, formatting, semantic rename, and edit-only code
actions; plus configured task and named run/debug control. The exact inventory and
limits are in `TOOL_CONTRACT.md` and the repository's `docs/tool-contract-v1.0.md`.

Results include explicit version, freshness, limit, and truncation metadata where the
contract requires it. The bridge does not expose a generic shell, terminal input, Git,
arbitrary VS Code command, debug-console evaluation, arbitrary DAP request, overwrite,
or recursive deletion capability.

## Security and scope

- Only trusted, explicitly enabled, local `file:` workspaces are eligible.
- Runtime discovery and IPC are user-scoped, authenticated, versioned, and bounded.
- The extension reauthorizes every document and provider-returned location against the
  selected canonical workspace.
- Multiple windows and multi-root workspaces use deterministic selection rules.
- Write and task/debug execution are independent, visible, memory-only session grants
  that start disabled and are revoked on lifecycle or workspace-authority loss.
- Provider-owned top-level and nested arrays are traversed only to fixed raw budgets
  before public result limits, with explicit omission warnings.
- Cancellation and timeout settle the client promptly while non-cancellable host work
  continues consuming its execution slot until the original promise settles.
- Remote SSH, WSL, Dev Containers, Codespaces, VS Code for the Web, virtual workspaces,
  Windows, Snap, and Flatpak are not supported by version 1.0.
- No network listener, updater, telemetry, analytics, or persistent content logging is
  included.

An MCP client can transmit returned source or language-provider data elsewhere. Review
that client's privacy and model settings independently.

## Distribution and installation

The complete product is distributed through one GitHub Release. The identical verified
extension VSIX is also published to the VS Code Marketplace; the matching server still
comes from GitHub. Download the complete version-matched file set named by `SHA256SUMS`,
verify it, then follow the release's `INSTALLATION.md` guide. Open VSX, npm, JSR, Yarn,
and Bun are not distribution channels.

The release directory also includes a CycloneDX 1.5 SBOM, a machine-readable release
manifest, the Apache-2.0 project license and notice, and full license texts for bundled
production dependencies.

## Compatibility gate

- VS Code Desktop 1.101.0 or newer in the declared extension engine range.
- Node.js 22.13.0 or newer in the supported Node.js 22 line for the server CLI.
- The supported executable IPC path has clean macOS and Linux acceptance evidence.
- Windows is explicitly outside the 1.0 support matrix and fails closed before listener
  or registry publication. Future support requires a separately reviewed native ACL
  boundary and real two-account tests.

Upgrade or downgrade the extension and server together. Contract or component version
mismatches fail closed rather than negotiating an unreviewed compatibility mode.

No `0.x`, preview, alpha, beta, or public release-candidate version has been published.
