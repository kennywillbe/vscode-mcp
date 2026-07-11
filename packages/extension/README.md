# VS Code MCP

Secure local MCP access to VS Code's live editor state, repository search, language
intelligence, controlled workspace edits, configured tasks, and named run/debug
configurations.

> Installing this Marketplace extension is one half of the setup. You must also install
> the matching `vscode-mcp` server from the same GitHub Release and add it to your MCP
> client configuration.

## Install

1. Install **VS Code MCP** from the VS Code Marketplace.
2. Download the matching server archive and `SHA256SUMS` from the
   [GitHub Releases page](https://github.com/kennywillbe/vscode-mcp/releases).
3. Verify and extract the server, then configure your MCP client using the
   [installation guide](https://github.com/kennywillbe/vscode-mcp/blob/main/docs/installation.md).
4. Open a trusted local workspace and run **VS Code MCP: Enable for This Workspace**.

The extension and server must use a compatible IPC/tool contract. For version 1.0,
install the two `1.0.0` components together.

## Capabilities

- Bounded file discovery, batch reads, and dirty-buffer-aware literal search.
- Diagnostics, navigation, symbols, completions, code actions, hierarchies, hints,
  folds, selections, and document links through VS Code providers.
- Version-checked multi-document edits, create/move/delete, save/revert, rename,
  formatting, and inspectable text-edit-only code actions.
- Configured VS Code tasks and exact named run/debug configurations.

Read access is enabled per trusted workspace. Write and task/debug execution are
separate visible, memory-only session grants that default to off and are independently
revocable.

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
