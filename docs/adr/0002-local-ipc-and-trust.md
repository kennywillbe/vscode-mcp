# ADR 0002: Local IPC and trust boundary

- Status: Accepted
- Date: 2026-07-10
- Amended: 2026-07-10 — 1.0 platform scope corrected to macOS/Linux
- Scope: v0.1 local VS Code Desktop, read-only tools

## Context

The MCP client must reach the live VS Code extension host without exposing a long-lived
unauthenticated network service. Multiple VS Code windows may be open, including two
windows for the same workspace, so selecting the first or most recently focused window
is not deterministic enough.

## Decision

```text
MCP client --stdio--> bridge --local IPC--> VS Code extension
```

- The public MCP transport is `stdio` only.
- The bridge and extension do not open TCP, HTTP, or SSE listeners.
- Unix domain sockets are used on the supported macOS and Linux runtimes.
- Windows is not supported by version 1.0. It fails closed before listener or registry
  publication; the named-pipe schema is reserved for a separately reviewed future
  transport and does not imply support.
- IPC uses JSON-RPC 2.0 messages with `Content-Length` framing. A project-owned bounded
  reader enforces header and directional body ceilings before JSON parsing, then
  `vscode-jsonrpc` owns request correlation and cancellation semantics.
- The first request is `vscode-mcp/hello`, extension-backed tool requests use
  `vscode-mcp/callTool`, and cancellation uses `$/cancelRequest`.
- Every VS Code window owns a separate IPC endpoint, registry record, instance
  identifier, and randomly generated 256-bit session token.
- The extension is the authority for workspace scope and authorization. It revalidates
  every path and does not trust registry or bridge claims.
- A workspace is eligible only when it is trusted, contains at least one local `file:`
  folder, and the user has explicitly enabled MCP for its canonical workspace
  fingerprint.
- Target selection is deterministic and fails on ambiguity. There is no silent "last
  focused window" fallback.

## Target-selection order

1. Exact `--instance <id>` match.
2. Canonical `--workspace <absolute-path>` match.
3. The deepest canonical workspace root containing the bridge process `cwd`.
4. The only eligible instance, if exactly one exists.

Any step that leaves multiple candidates returns an ambiguity error with safe instance
metadata. The bridge verifies the selected registry record against the extension's
authenticated handshake response.

`--instance` and `--workspace` pin the bridge's upper scope. A tool-level `instanceId`
cannot escape that scope. Two windows for the same workspace are ambiguous unless the
client selects the ephemeral instance ID; v0.1 has no persistent instance aliases.

`list_instances` is implemented by the bridge, not forwarded as an extension tool. It
returns only instances whose registry record has been verified through a live,
authenticated handshake.

## Consequences

- A client-spawned process has standard MCP `stdio` isolation and does not need a stable
  port.
- Multi-window and multi-root behavior is testable and predictable.
- A small instance registry and IPC authentication protocol must be maintained.
- Windows named-pipe ACL behavior and sandboxed VS Code distributions require separate
  future architecture and compatibility work before they can enter the support matrix.

The accepted [IPC protocol](../internal-ipc-v1.md) is the canonical wire and lifecycle
contract. See [the security model](../security-model.md) for authorization rules and
limits, and [the acceptance criteria](../security-acceptance-criteria.md) for the
Milestone 1 test gate.
