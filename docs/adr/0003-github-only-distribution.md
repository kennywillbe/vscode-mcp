# ADR 0003: GitHub-only distribution

- Status: Superseded by ADR 0008
- Date: 2026-07-10

## Context

`vscode-mcp` has two required components: a VS Code extension and a standalone MCP
`stdio` bridge. The VS Code Marketplace distributes extensions, not the complete MCP
integration, and the intended audience is comfortable installing development tooling
from a GitHub release.

Publishing the two halves through unrelated registries would add release coordination,
publisher credentials, registry-specific metadata, and version-skew risks without
improving the core product.

## Decision

- Development remains local and unpublished until the roadmap and all release gates are
  complete.
- No public `0.x`, preview, alpha, beta, or release-candidate repository/release is
  created. Internal package and contract versions may remain pre-1.0 during development.
- The repository is created and made public only for the completed `1.0.0` release.
- Versioned binaries are distributed only as GitHub Release assets.
- Each release will contain:
  - a sideloadable, versioned `.vsix` extension;
  - a version-matched, platform-neutral server archive containing the bundled Node.js
    CLI;
  - SHA-256 checksums;
  - applicable licenses and third-party notices;
  - installation, MCP client configuration, upgrade, and removal instructions.
- The server archive requires the supported Node.js runtime; it will not be published to
  npm, Yarn, JSR, or another package registry.
- The extension will not be published to the VS Code Marketplace or Open VSX.
- Releases and updates are explicit user actions. The project will not implement a
  separate updater or telemetry service.

The initial installation flow will be intentionally transparent:

1. Download both version-matched assets from one GitHub Release.
2. Install the extension with **Extensions: Install from VSIX...** or
   `code --install-extension <file>.vsix`.
3. Extract the server archive to a stable local path.
4. Point the MCP client configuration to `node <path>/cli.mjs`.

## Consequences

- Early development history and incomplete artifacts are not presented as supported
  public software.
- Users can inspect one source repository and one release before installing both halves.
- Extension and protocol versions remain coordinated.
- The project does not need marketplace or registry publisher credentials.
- Installation and upgrades are more manual, so release documentation and checksums are
  mandatory.
- Marketplace discovery and automatic extension updates are intentionally traded for a
  smaller trust and release surface.
- A future distribution-channel change requires a new ADR and explicit maintainer
  approval.
