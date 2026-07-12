# vscode-mcp 1.1.0 release notes

Version 1.1.0 is a coordinated extension and server feature release focused on making
long-running coding-agent workflows easier to inspect and more resilient. The existing
39-tool contract remains `vscode-mcp.tools/1.0.0`; the release adds compatible result
metadata and extension-owned review UI without adding an arbitrary command surface.

## Agent-oriented change review

- Every successful MCP workspace mutation can now produce bounded, theme-aware editor
  decorations, overview-ruler markers, Explorer badges, and a visible changed-file
  count.
- A single changed file opens in VS Code's native side-by-side diff editor. Multiple
  changed files open together in VS Code's native multi-file changes editor, matching
  the familiar source-control review workflow.
- Next/previous navigation targets exact post-edit ranges. Changes may be cleared per
  file or for the complete listener session.
- Before-snapshots and visual metadata are memory-only and bounded. They are destroyed
  by manual follow-up edits, write revocation, workspace disable, listener restart, or
  extension reload.

## Workflow fidelity and recovery

- Configured package-script tasks report their detected package manager separately from
  VS Code's task source while continuing to withhold command, arguments, environment,
  and path data.
- Literal workspace search accepts meaningful leading or trailing whitespace and
  publishes its context-line maximum directly in the MCP input schema.
- Document-symbol responses use a bounded flat-provider fallback when a provider omits
  hierarchy members and report an explicit warning when completeness cannot be proven.
- Instance discovery retains a short, bounded in-memory replacement mapping so an
  `INSTANCE_NOT_FOUND` response can point an agent at the rotated instance identity for
  the same authorized workspace.

## Compatibility and distribution

Use the 1.1.0 extension and server together. The supported path remains standard local
VS Code Desktop 1.101 or newer on macOS and Linux with Node.js 22.13 or newer in the
Node.js 22 line. Windows, remote, web, virtual, and sandboxed workspaces remain
unsupported and fail closed.

The complete checksummed release is distributed through GitHub Releases. The exact VSIX
from that release is uploaded to the VS Code Marketplace without rebuilding it. The
project does not publish the server to npm or another package registry.
