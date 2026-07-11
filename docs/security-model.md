# Security model

> This document is the inherited v0.1 read/transport baseline. The active complete
> product adds the accepted controls in
> [`security-model-v1.0-full-ide.md`](./security-model-v1.0-full-ide.md); where the two
> differ, the full 1.0 model is authoritative.

- Status: Accepted
- Security model ID: `vscode-mcp.security/0.1`
- Date: 2026-07-10

## Scope and assets

Version 0.1 exposes live read-only editor and language-provider information from an
explicitly enabled local VS Code workspace. Source text, unsaved buffers, selections,
diagnostics, hover text, workspace structure, and local paths are sensitive assets even
when no mutation tool exists.

The design reduces accidental cross-workspace access and unauthenticated local network
access. It does not defend against a malicious process already running as the same
operating-system user, a compromised VS Code extension host, or an MCP client that sends
returned source data to a remote model.

## Eligibility and lifecycle

An extension instance is published only when all of these conditions hold:

- It runs in VS Code Desktop in a local extension host.
- At least one local `file:` workspace folder is open.
- `vscode.workspace.isTrusted` is `true`.
- The user enabled MCP for the canonical workspace fingerprint.

Enablement is stored by the extension in user-owned state, never in repository settings.
Changing the workspace-folder set creates a new fingerprint and requires explicit
enablement. When trust is lost or MCP is disabled, new calls are rejected, live
connections are closed, the registry record is removed, and the session token is
rotated.

Remote SSH, WSL, Dev Containers, Codespaces, VS Code for the Web, virtual workspaces,
and untitled workspaces are deferred until their trust and routing models are designed
and tested.

The 1.0 support target is standard local VS Code Desktop on macOS and Linux. Windows,
Snap, Flatpak, and other sandboxed distributions are explicitly unsupported. Windows
fails closed before listener or registry publication; future Windows support requires a
separate native-ACL architecture and review.

## IPC endpoints

### Unix

- Prefer `$XDG_RUNTIME_DIR/vscode-mcp` when it is user-owned and secure.
- Otherwise use a user-specific runtime directory under the operating-system temporary
  directory.
- Reject a runtime directory that is a symlink, owned by another user, or more
  permissive than mode `0700`.
- Create files under `umask 077`; registry records use `0600`.
- Socket names include at least 128 random bits and are never derived only from a
  predictable PID or workspace path.
- Never delete an unsafe or foreign-owned endpoint to recover startup.

### Windows (deferred from 1.0)

Version 1.0 publishes no Windows endpoint or registry record. The reserved future
contract would use `\\.\pipe\vscode-mcp-<instance-id>-<random>`, store records below the
current user's local application-data directory, and require effective owner-only ACL
verification before Windows could be declared supported. These are future enablement
requirements, not 1.0 acceptance gates.

## Registry and authentication

Each window writes one atomically replaced registry record containing protocol versions,
instance ID, PID, timestamps, endpoint kind/address, session token, workspace
fingerprint, and canonical roots. Registry content is untrusted until the endpoint
completes a handshake.

- Tokens are 256 random bits and rotate with every listener start.
- The first IPC message must be a versioned `hello` request containing the instance ID
  and token.
- Token comparison is constant-time and has a three-second timeout.
- Failed authentication returns only a generic error and closes the connection.
- A normally completed authenticated session uses a strict empty `closeSession` request.
  The extension flushes its bounded acknowledgement, removes the session from admission
  accounting, and closes the server-side socket before the bridge opens the next
  session. The acknowledgement and peer-close barrier is capped at three seconds;
  failures fall back to force-close without exposing close details.
- Client name and PID are diagnostics, never authorization signals.
- Tokens and endpoint addresses are excluded from tools and logs.
- PID liveness alone never authenticates an instance.

Records receive a heartbeat. A record is stale only when its heartbeat is old and its
endpoint cannot complete an authenticated probe. The extension updates its heartbeat
every five seconds. A record becomes a stale candidate after sixty seconds and the
bridge then allows three seconds for the probe. Before deletion, the bridge re-reads the
record and removes it only if its instance ID, endpoint, token, and heartbeat are
unchanged. It never unlinks the endpoint itself and never uses PID liveness as proof.

Registry records are capped at 64 KiB before JSON parsing. Discovery considers only
regular `<instanceId>.json` files whose names contain a valid instance UUID; symlinks,
directories, devices, malformed files, and unsafe permissions are rejected without
following or repairing them.

## Workspace isolation

The extension performs all checks at call time:

- Accept only local `file:` targets in v0.1.
- Resolve workspace roots and targets with `realpath`.
- Use platform-aware relative-path containment, not string-prefix matching.
- Reject targets outside the selected roots, including symlink escapes.
- Filter out-of-scope open tabs and language-provider locations.
- Reject untitled, settings, virtual, and extension-resource documents.
- Invoke only a fixed internal list of language-provider commands.
- Never accept an arbitrary VS Code command, shell command, or executable.

Repository and language-extension output, including hover and diagnostic text, is
untrusted content and is returned as data rather than instructions.

The authenticated `list_instances` response deliberately discloses eligible workspace
folder names and `file:` URIs to the MCP client because instance selection requires
them. Canonical paths, registry paths, PIDs, endpoints, and tokens remain internal. This
authorized result data is still sensitive and is never logged.

## Initial resource limits

| Resource                             | Default |    Hard limit |
| ------------------------------------ | ------: | ------------: |
| Framing header                       |       — |         8 KiB |
| Incoming MCP message                 |       — |       256 KiB |
| Registry record                      |       — |        64 KiB |
| Bridge-to-extension IPC frame        |       — |       256 KiB |
| Extension-to-bridge IPC frame        |       — |         2 MiB |
| Serialized MCP success result        |       — |       512 KiB |
| `read_document` returned text        |       — |       256 KiB |
| Closed file before VS Code opens it  |       — |        10 MiB |
| Reference context snippet            |       — |         4 KiB |
| Hover/signature combined content     |       — |        64 KiB |
| Diagnostic or related-info message   |       — |        16 KiB |
| Open-document source scan            |       — |         8,000 |
| Open documents in diagnostics result |       — |           200 |
| Raw diagnostics / related entries    |       — |    8,000 each |
| Raw document-symbol nodes / depth    |       — |   8,000 / 128 |
| Raw calls / call-site ranges         |       — | 1,000 / 4,000 |
| Simple operation                     |     5 s |           5 s |
| Language-provider operation          |    15 s |          15 s |
| Authenticated session close          |     3 s |           3 s |
| Diagnostic quiet/max-wait period     |  300 ms |      1,500 ms |
| Connections per window               |       — |             4 |
| Concurrent calls per connection      |       — |             4 |
| Concurrent calls per window          |       — |             8 |
| Queued calls per window              |       — |            16 |

Truncation is always explicit and includes returned count, truncation state, and total
count when known. Provider-owned arrays are copied by numeric index only up to a fixed
raw budget before any normalization, sorting, searching, mapping, spreading, or public
schema validation. Nested diagnostic, hover, signature, symbol, and call-site arrays
have independent per-item and per-request budgets; public result limits are narrower.

Client settlement and execution settlement are separate. Cancellation, timeout, or
disconnect produces at most one prompt client outcome and discards every late value, but
a non-cancellable active operation continues consuming its per-connection and per-window
execution slot until the original host promise settles. A never-settling provider can
therefore occupy, but cannot exceed or recycle, the four/eight execution ceilings.
Queued work releases immediately and never invokes its handler.

Tool-specific item defaults and hard limits are defined by the accepted tool contract;
the largest top-level collection cap is 2,000 items. The 300/1,500 ms diagnostic
freshness wait is part of, rather than additional to, the five-second diagnostics
budget. The bridge measures the complete MCP success payload once after structured and
text content are assembled; it does not duplicate the same JSON in both forms.

## Logging and telemetry

Logs may contain lifecycle events, tool names, durations, outcome categories, item
counts, timeouts, and truncation state. They never contain session tokens, request
bodies, source text, selection text, hover/diagnostic content, environment variables,
usernames, or absolute paths.

Version 0.1 has no telemetry and no persistent file logging. Diagnostic settings are
user-scoped and repository settings cannot weaken the security model.

Every v0.1 MCP tool is annotated as read-only and non-destructive, but these annotations
are descriptive hints and never replace server-side enforcement.

The accepted [internal IPC contract](./internal-ipc-v1.md) defines the canonical wire,
registry, and lifecycle behavior. The
[Milestone 1 acceptance criteria](./security-acceptance-criteria.md) turn these
boundaries into required test cases.

## Deferred environments and future work

- Design and verify a native owner-only named-pipe/registry ACL boundary before adding
  Windows to a future support matrix.
- Test Unix socket behavior in sandboxed VS Code distributions before declaring those
  distributions supported.
- Test external edits and language-server lag without claiming false diagnostic
  completeness.
- Document that an MCP client may transmit returned source data outside the machine.
- Same-workspace duplicate windows require explicit ephemeral `instanceId` selection in
  v0.1. Persistent aliases are intentionally deferred under YAGNI.
