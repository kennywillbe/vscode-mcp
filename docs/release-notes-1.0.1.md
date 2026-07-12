# vscode-mcp 1.0.1 release notes

Version 1.0.1 is a coordinated extension and server patch release. It fixes the
first-activation listener lifecycle race observed in the 1.0.0 GitHub Actions run while
preserving the frozen 1.0 MCP tool and IPC contract.

## Fixed

- Ordered the activation-time client-setup state write before workspace-enable commands
  can run.
- Added bounded observation of the enabled workspace state for VS Code 1.101 without
  rewriting authorization; a concurrent disable remains authoritative.
- Added bounded listener-start recovery for transient local registry publication
  failures, with complete socket and registry cleanup between attempts.
- Replaced ambiguous discovery timeouts with safe reason, startup-stage, eligible
  instance count, and registry record count diagnostics.
- Prevented the enable command from reporting success unless authenticated local IPC is
  ready for the expected workspace identity.

## Compatibility and security

The 39-tool contract remains `1.0.0`; no tool or schema changed. Version 1.0.1 supports
standard local VS Code Desktop 1.101.0 or newer on macOS and Linux with Node.js 22.13.0
or newer in the Node.js 22 line. Windows, remote, web, virtual, and sandboxed workspaces
remain unsupported and fail closed.

Use the 1.0.1 extension and server together. The complete product is distributed by the
GitHub Release. The exact checksummed GitHub Release VSIX is also the only artifact
approved for the VS Code Marketplace update; it must not be rebuilt or modified between
channels.
