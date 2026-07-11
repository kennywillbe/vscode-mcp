# Install and configure vscode-mcp

> [!IMPORTANT] This is the installation guide intended for the first 1.0 release. No
> release has been published. Version 1.0 supports standard local VS Code Desktop on
> macOS and Linux. Windows is not supported and fails closed before IPC publication.

The complete product is distributed as two version-matched files in one GitHub Release:

- `vscode-mcp-extension-1.0.0.vsix` runs inside local VS Code Desktop.
- `vscode-mcp-server-1.0.0.tar.gz` contains the MCP `stdio` bridge.

The extension is also available from the VS Code Marketplace. Marketplace installation
does not install the server: download the matching server archive from the corresponding
GitHub Release. Do not mix incompatible IPC/tool contracts. Open VSX, npm, and other
package registries are not distribution channels for this project.

Repository contributors who need an unpublished source build should use the separate
[local development guide](./development.md). Its `setup:local` output is for testing and
is not a public release artifact.

## Requirements

- macOS or Linux with a standard local installation of VS Code Desktop 1.101.0 or newer.
- Node.js 22.13.0 or newer in the Node.js 22 line.
- A local `file:` workspace that you are willing to trust and explicitly expose.
- An MCP client that can start a local `stdio` server.

Windows, Remote SSH, WSL, Dev Containers, Codespaces, VS Code for the Web, virtual
workspaces, Snap, and Flatpak are not supported by version 1.0. Windows returns
`WINDOWS_ACL_NOT_IMPLEMENTED` before creating a listener or registry record; see the
[Windows support plan](./windows-support-plan.md).

## Verify the release files

Download the complete file set from one GitHub Release: both executable artifacts and
every supporting file named in `SHA256SUMS`. From that download directory, verify the
checksums before installing:

```sh
shasum -a 256 -c SHA256SUMS
```

On Linux, `sha256sum -c SHA256SUMS` is equivalent.

## Fresh installation

1. Install **VS Code MCP** from the VS Code Marketplace. Alternatively, install the
   checksummed GitHub Release VSIX using **Extensions: Install from VSIX...** or:

   ```sh
   code --install-extension /absolute/path/vscode-mcp-extension-1.0.0.vsix
   ```

2. Extract the bridge archive to a user-owned, stable directory:

   ```sh
   mkdir -p "$HOME/.local/share/vscode-mcp/1.0.0"
   tar -xzf vscode-mcp-server-1.0.0.tar.gz \
     -C "$HOME/.local/share/vscode-mcp/1.0.0"
   ```

3. Open the local workspace in VS Code, review the Workspace Trust prompt, and trust it
   only if you trust its contents.

4. Run **VS Code MCP: Enable for This Workspace** from the Command Palette. Enablement
   is stored in user-owned VS Code state for the canonical workspace-folder set; it is
   not written into the repository.

5. Add a local `stdio` server to your MCP client. Adapt the outer property names to the
   client, but keep the command and arguments equivalent to:

   ```json
   {
     "mcpServers": {
       "vscode": {
         "command": "node",
         "args": ["/absolute/path/to/vscode-mcp/1.0.0/vscode-mcp-server/cli.mjs"]
       }
     }
   }
   ```

6. Restart or reload the MCP client, then call `list_instances`. Only authenticated,
   trusted, explicitly enabled windows are listed. Tokens, process IDs, endpoints, and
   canonical filesystem paths are never returned.

7. Read and language tools are now available. When mutation is needed, run **VS Code
   MCP: Enable Writes for This Session**. When a configured build/test task or named
   run/debug configuration is needed, separately run **VS Code MCP: Enable Task and
   Debug Execution for This Session**. These grants are memory-only, visible in **VS
   Code MCP: Show Status**, independently revocable, and intentionally do not survive a
   reload.

See the [agent usage guide](./agent-usage-guide.md) for the recommended discovery,
semantic navigation, edit, diagnostic, task, and debug workflows.

When multiple eligible windows exist, pass the returned `instanceId` to an
instance-bound tool. To restrict a bridge process for its whole lifetime, add exactly
one selector to its arguments:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/vscode-mcp-server/cli.mjs",
    "--workspace",
    "/absolute/path/to/workspace"
  ]
}
```

`--instance <uuid>` is also supported. A command-line selector is an upper security
scope: a per-call selector may narrow it but cannot override it.

## Upgrade

1. Download and verify the new release's server archive and checksums. If you sideload
   the extension, also download its VSIX; Marketplace installations update through VS
   Code according to the user's extension update settings.
2. Stop MCP clients that are using the old bridge.
3. Confirm the Marketplace extension has the intended compatible version, or install the
   new VSIX with **Extensions: Install from VSIX...**.
4. Extract the matching server archive into a new versioned directory.
5. Change the MCP client command to the new `cli.mjs`, then restart VS Code and the MCP
   client.
6. Confirm that `list_instances` reports the expected protocol and tool-contract
   versions before deleting the old server directory.

## Downgrade

Downgrade both parts together. Stop the MCP client, install the older VSIX, point the
client at the matching older server archive, and restart both processes. A mismatched
bridge and extension fail closed during their authenticated handshake; they do not
negotiate down to an older contract.

## Disable or remove

To stop exposing one workspace without uninstalling anything, run **VS Code MCP: Disable
for This Workspace**. The extension closes live connections, removes its registry record
and socket, and rotates away the session token.

For complete removal:

1. Disable every enabled workspace.
2. Remove the MCP server entry from the client and stop the client.
3. Uninstall **VS Code MCP** from VS Code, or run
   `code --uninstall-extension vscode-mcp.vscode-mcp`.
4. Delete the extracted server directories and downloaded release files.

The bridge never installs a background service, network listener, shell integration,
auto-updater, or telemetry component.

## Security notes

The tools expose source text, unsaved buffers, diagnostics, and language-provider output
to the configured MCP client. That client may send returned data outside the machine.
Review its privacy policy and model configuration separately. Report suspected security
issues using the private process in the release's `SECURITY.md`; do not include source
content, tokens, or local paths unless essential and redacted.
