# VS Code MCP

Secure local MCP access to VS Code's live editor state, repository search, language
intelligence, controlled workspace edits, configured tasks, and named run/debug
configurations.

> The extension contains the exact version-matched local server. Setup is explicit and
> local: no background download, updater, or service is installed.

## Install

1. Install **VS Code MCP** from the VS Code Marketplace.
2. Run **VS Code MCP: Set Up MCP Client** and choose automatic Codex setup or copy a
   reviewable config snippet for another client.
3. Review and approve the exact configuration block, then restart the MCP client.
4. Open a trusted local workspace and run **VS Code MCP: Enable for This Workspace**.

The setup command verifies and installs the bundled server under VS Code's user storage.
The standalone checksummed server archive remains available from GitHub Releases for
manual installations. See the complete
[installation guide](https://github.com/kennywillbe/vscode-mcp/blob/main/docs/installation.md).

## Capabilities

- Bounded file discovery, batch reads, and dirty-buffer-aware literal search.
- Diagnostics, navigation, symbols, completions, code actions, hierarchies, hints,
  folds, selections, and document links through VS Code providers.
- Version-checked multi-document edits, create/move/delete, save/revert, rename,
  formatting, and inspectable text-edit-only code actions.
- Theme-aware added/modified/deleted highlights, overview-ruler markers, Explorer
  badges, single-file and multi-file diff review, and next/previous navigation for
  MCP-authored changes.
- Configured VS Code tasks and exact named run/debug configurations.

Read access is enabled per trusted workspace. Write and task/debug execution are
separate visible, memory-only session grants that default to off and are independently
revocable.

## Review MCP changes

Every successful content mutation is attributed visually:

- green marks added text, blue marks replacements, and red marks deletion anchors;
- the overview ruler and Explorer A/M badges show affected locations and files;
- click **MCP: _n_ changed** to open one side-by-side diff or a single multi-file
  changes editor when several files were changed;
- run **VS Code MCP: Go to Next Highlighted Change** or **Go to Previous Highlighted
  Change** to navigate exact ranges; and
- clear the active file or the complete session with the matching **Clear Change
  Highlights** commands.

The `vscodeMcp.changeHighlights` settings control rendering, Explorer badges, and the
status item. Metadata and before-snapshots are bounded, memory-only, and never written
to disk or returned over MCP. Manual edits clear attribution for the affected file so
stale ranges are never presented as MCP-authored.

There is no generic shell, terminal input, Git control, arbitrary VS Code command,
debug-console evaluation, arbitrary DAP request, telemetry, or network listener.

## Compatibility

Version 1.0 supports standard local VS Code Desktop 1.101.0 or newer on macOS and Linux.
Windows, Remote SSH, WSL, Dev Containers, Codespaces, VS Code for the Web, virtual
workspaces, Snap, and Flatpak are not supported and fail closed.

## Security and privacy

Review the [security policy](https://github.com/kennywillbe/vscode-mcp/security/policy)
before reporting a vulnerability. The extension does not send telemetry or workspace
content to the project maintainers. See the
[privacy statement](https://github.com/kennywillbe/vscode-mcp/blob/main/PRIVACY.md) for
the boundary between this local bridge and the user's MCP client/model.

Documentation, support, source, checksums, SBOM, and complete release artifacts are in
the [GitHub repository](https://github.com/kennywillbe/vscode-mcp).
