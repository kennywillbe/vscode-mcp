# ADR 0001: Project foundation

- Status: Accepted
- Date: 2026-07-10

## Context

`vscode-mcp` needs both a VS Code extension process and a local MCP `stdio` process.
Existing projects demonstrate useful patterns, but their licenses, transport choices,
tool surfaces, and security assumptions do not match this project's intended boundary.

The VS Code generator produces a standalone extension, while this repository also needs
a shared protocol package and an independently launched MCP bridge. The MCP TypeScript
SDK v2 is pre-release; the official project currently recommends v1.x for production
use.

## Decision

- Implement the project clean-room. Existing implementations may inform behavior, but
  their source code will not be copied.
- Use a pnpm TypeScript monorepo with three packages: `extension`, `server`, and
  `protocol`.
- Follow the official VS Code TypeScript extension structure inside the extension
  package, adapted for the monorepo.
- Pin the stable MCP TypeScript SDK v1 behind a small adapter owned by the server
  package. Upgrade only after SDK v2 is stable and compatibility tests pass.
- Bundle runtime JavaScript with esbuild and keep package boundaries visible in source
  and tests.
- License original project code under Apache-2.0.
- Distribute the complete product through GitHub Releases and the exact verified VSIX
  through the VS Code Marketplace under ADR 0008. Package-registry publication remains
  out of scope.

## Consequences

- The repository owns its architecture and avoids inheriting another project's unsafe
  tools or compatibility constraints.
- The extension and MCP bridge can evolve independently while sharing one versioned
  contract.
- The SDK adapter adds a small amount of code but limits migration work when MCP SDK v2
  becomes stable.
- Third-party code bundled in release artifacts must be covered by a maintained
  third-party notices file.
