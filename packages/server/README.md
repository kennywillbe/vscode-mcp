# vscode-mcp server

This directory contains the bundled `stdio` bridge for the matching VS Code MCP
extension. It is not a background service and does not open a network listener. The MCP
client starts `cli.mjs` with Node.js and communicates with it over standard input and
standard output.

Use the extension and server from the same `1.1.0` GitHub Release. A component or
contract mismatch fails closed.

## Run from an MCP client

Node.js 22.13.0 or newer in the supported Node.js 22 line is required. Version 1.0
supports standard local VS Code Desktop on macOS and Linux; Windows and remote/web/
virtual/sandboxed workspaces are unsupported. Configure the client's local MCP server
command in this form:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/vscode-mcp-server/cli.mjs"]
}
```

Use exactly one optional process-wide selector when a client must be restricted to one
window or workspace:

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

`--instance <uuid>` is the alternative selector. Run `list_instances` without a selector
to discover eligible windows. The extension must be installed, the local workspace must
be trusted, and **VS Code MCP: Enable for This Workspace** must have been run first.

Standard output is reserved for MCP protocol messages. Operational diagnostics use
standard error and never include session tokens, source contents, provider payloads, or
full local paths.

See `INSTALLATION.md` for checksum verification, complete configuration, upgrade,
downgrade, disable, and removal instructions. See `SECURITY.md` before reporting a
suspected vulnerability. Release archives also include `AGENT_USAGE.md` and
`TOOL_CONTRACT.md` for the recommended 39-tool workflows and exact schemas/boundaries.
