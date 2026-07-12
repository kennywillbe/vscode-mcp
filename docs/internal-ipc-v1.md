# Internal IPC contract v1

- Status: Accepted
- Contract ID: `vscode-mcp.ipc/1`
- Registry schema version: `1`
- IPC protocol version: `1`
- Tool contract: `vscode-mcp.tools/1.0.0`
- Scope: local VS Code Desktop on macOS/Linux, complete 1.0 IDE tools with separate
  grants

## Purpose and authority

This contract defines the private connection between the `packages/server` bridge and
one `packages/extension` instance. It covers discovery, authentication, framing,
handshake state, request routing, cancellation, capacity, errors, and lifecycle.

The public side of the bridge remains MCP over `stdio`. The supported private side uses
a Unix-domain socket on macOS and Linux. Neither process opens a TCP, HTTP, or SSE
listener. The Windows endpoint shape is reserved for future protocol compatibility, but
version 1.0 fails closed before publishing it.

The extension is the authorization authority. A registry record, CLI selector, bridge
decision, process ID, or successful socket connection never authorizes access. The
extension MUST re-check Workspace Trust, explicit enablement, workspace scope, document
versions, and path containment for every tool call.

Protocol v1 is fixed rather than negotiated. Limits and capabilities can only change in
a compatible contract revision or a new IPC protocol version.

## Terminology

- **Bridge:** the MCP `stdio` process in `packages/server`.
- **Extension:** one VS Code extension-host instance in `packages/extension`.
- **Instance:** one eligible VS Code window and its extension-side listener.
- **Pinned selector:** a CLI selector that restricts which instances the bridge may use
  for its entire lifetime.
- **Tool failure:** an expected, structured failure from the public tool contract.
- **IPC error:** a framing, JSON-RPC, handshake, or connection-state failure that is not
  a public tool result.

## Transport and framing

The connection uses `vscode-jsonrpc` messages conforming to JSON-RPC 2.0, carried with
`Content-Length` framing. Both processes MUST provide `vscode-jsonrpc` with a custom
bounded message reader and writer. A generic unbounded stream reader MUST NOT receive
untrusted IPC bytes.

Each message has this shape on the byte stream:

```text
Content-Length: <decimal UTF-8 body byte count>\r\n
[Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n]
\r\n
<one JSON-RPC 2.0 object encoded as UTF-8>
```

The following framing rules are normative:

- The header section, including the terminating `\r\n\r\n`, MUST NOT exceed 8 KiB.
- Exactly one `Content-Length` header is required. Its value MUST contain only decimal
  digits after optional HTTP-style whitespace, fit in a nonnegative JavaScript safe
  integer, and respect the directional body limit before body storage is allocated.
- `Content-Type` is optional. When present, it MUST identify UTF-8. Duplicate
  `Content-Type`, duplicate `Content-Length`, transfer encoding, compression, and
  unknown framing headers are rejected.
- Headers use ASCII and `\r\n`; LF-only framing is rejected.
- A body contains exactly one JSON object. JSON-RPC batch arrays are unsupported.
- The body MUST be valid UTF-8 and valid JSON with `jsonrpc: "2.0"`.
- The reader MUST incrementally search for the header terminator without allowing its
  buffer to grow beyond 8 KiB. It MUST validate `Content-Length` before reserving or
  reading the complete body.
- A malformed header, oversized header, oversized declared body, invalid UTF-8,
  truncated body, batch, or malformed JSON closes the connection. The receiver SHOULD
  avoid replying when it cannot safely identify a valid request ID.
- Bytes following a complete frame belong to the next frame. There is no delimiter after
  the body and no compression or continuation frame.

Directional body limits are measured against the declared and actual UTF-8 JSON body:

| Direction           | Maximum body |
| ------------------- | -----------: |
| Bridge to extension |      256 KiB |
| Extension to bridge |        2 MiB |

The writer MUST serialize first, measure UTF-8 bytes, and refuse to write an oversized
body. A local attempt to write above a directional limit is an invariant failure: log
only safe metadata, fail the affected operation, and close the connection. The 2 MiB
extension-to-bridge ceiling is not permission to exceed the separate 512 KiB MCP
success-result budget.

## JSON-RPC IDs and message ownership

Only the bridge originates requests in protocol v1. The extension returns responses;
either side may send a defined notification.

- Request and response IDs MUST be integer, nonnegative JavaScript safe integers.
- String, negative, fractional, `null`, and out-of-range IDs are invalid.
- The bridge allocates monotonically increasing IDs and MUST NOT reuse an ID while it is
  outstanding. It closes and reconnects before allocation would exceed
  `Number.MAX_SAFE_INTEGER`.
- A response with an unknown or duplicate ID is an IPC protocol error.
- Notifications have no `id` member.

The only methods in protocol v1 are:

| Method                    | Kind         | Sender |
| ------------------------- | ------------ | ------ |
| `vscode-mcp/hello`        | Request      | Bridge |
| `vscode-mcp/callTool`     | Request      | Bridge |
| `vscode-mcp/closeSession` | Request      | Bridge |
| `$/cancelRequest`         | Notification | Bridge |

All other methods receive JSON-RPC `Method not found` after authentication. Before
authentication, unexpected methods are handled as generic authentication failure so that
the listener is not a version or capability oracle.

## Registry location and secure directories

Every eligible instance publishes exactly one record named `<instanceId>.json` in the
user-scoped registry directory. An `instanceId` is a UUID generated for the lifetime of
the VS Code window's extension activation. Reloading the extension host creates a new
instance ID. Disabling and re-enabling within the same activation may retain the
instance ID, but always rotates the endpoint and token.

### macOS and Linux

The extension and bridge resolve the runtime root in this order:

1. `$XDG_RUNTIME_DIR/vscode-mcp` when `$XDG_RUNTIME_DIR` is absolute, owned by the
   current user, not a symlink, and not accessible by group or other users.
2. A user-specific `vscode-mcp-<uid>` directory below the operating-system temporary
   directory, subject to the same ownership, symlink, and permission checks.

Registry records live under `<runtime-root>/instances`. Unix sockets live under
`<runtime-root>/sockets` and use a short name containing at least 16 bytes of random
entropy. A socket name MUST NOT be derived only from the instance ID, PID, workspace, or
another predictable value.

Runtime and child directories MUST be owned by the current user and mode `0700`.
Registry files MUST be mode `0600`. Creation runs under `umask 077`. Each path component
MUST be checked with non-following metadata calls; a symlink, foreign owner, or broader
permission disables IPC rather than triggering an unsafe repair. Implementations MUST
NOT delete a foreign or unsafe directory or endpoint.

### Windows (reserved future transport; unsupported in 1.0)

Version 1.0 MUST NOT publish a Windows listener or registry record. It fails closed with
`WINDOWS_ACL_NOT_IMPLEMENTED` and has no shared temporary-directory or TCP fallback.

A future Windows transport would store registry records below
`%LOCALAPPDATA%\vscode-mcp\instances`, use `\\.\pipe\vscode-mcp-<instanceId>-<random>`
with at least 16 cryptographically random bytes, and require an owner-only protected ACL
verified before publication. Those requirements do not declare or gate Windows support
in protocol v1.

## Registry record schema

Records are UTF-8 JSON objects without a BOM and MUST be at most 64 KiB. Unknown schema
versions are ignored and MUST NOT be modified or deleted by a v1 implementation. Records
with a known version are validated strictly; unknown fields or invalid values make the
record ineligible.

The v1 logical schema is:

```ts
type RegistryRecordV1 = {
  schemaVersion: 1;
  protocolVersion: number; // Integer 1..65,535; classified before use.
  toolContractVersion: string; // Bounded semantic version; classified before use.
  instanceId: string; // UUID; matches the filename.
  extensionVersion: string; // 1..64 characters.
  pid: number; // Positive safe integer; diagnostic only.
  publishedAt: string; // RFC 3339 UTC.
  heartbeatAt: string; // RFC 3339 UTC.
  endpoint: { kind: 'unix'; path: string } | { kind: 'windowsNamedPipe'; path: string };
  authToken: string; // Exactly 43 unpadded base64url characters.
  displayName: string; // 1..512 characters.
  workspaceFingerprint: string; // 64 lowercase hex SHA-256 characters.
  workspaceFileUri: string | null; // At most 16,384 characters.
  workspaceFolders: Array<{
    workspaceFolderId: string; // 1..256 characters.
    name: string; // 1..512 characters.
    uri: string; // Local file URI, at most 16,384 characters.
    canonicalPath: string; // Absolute, at most 32,768 characters.
  }>; // 1..64 entries.
};
```

The record exists only while the instance is trusted, explicitly enabled, local,
listener-ready, and has at least one local workspace folder. Those claims remain
untrusted until the authenticated handshake returns matching instance metadata.
Canonical paths, PID, endpoint, token, and fingerprint MUST NOT be returned by
`list_instances` or written to logs.

The token is exactly 32 bytes from a cryptographically secure random source, encoded as
unpadded base64url. Its encoded form is therefore exactly 43 characters and matches
`^[A-Za-z0-9_-]{43}$`. A token rotates on every listener start and is never accepted by
another instance.

## Atomic publication and heartbeat

The listener MUST be accepting connections before its registry record becomes visible.
Creation and every heartbeat replace the entire record atomically:

1. Serialize and validate a complete record of at most 64 KiB.
2. Create an unpredictable, exclusive temporary file in the same registry directory with
   user-only permissions.
3. Write the full record, flush it, and close it.
4. Atomically replace `<instanceId>.json` with the temporary file using the platform's
   same-directory replacement primitive.
5. On Unix, flush the directory when the platform supports it.

In-place record mutation is forbidden. A failed replacement leaves the last complete
record or no record, never a partially written record. Temporary files are ignored by
discovery and may be removed only after their ownership, type, age, and name pattern are
validated.

The extension writes a heartbeat every 5 seconds by atomically replacing the record with
a new `heartbeatAt`. A publication or verification failure is retried up to three times
with a short fixed delay while the same listener and workspace eligibility remain
current. Persistent failure withdraws the listener and record; transient failure does
not rotate the instance ID. A record becomes a stale candidate when its validated
`heartbeatAt` is at least 60 seconds old. Age alone never permits deletion.

Stale cleanup requires all of the following:

1. Read, size-bound, and strictly validate the candidate record.
2. Confirm that `heartbeatAt` is at least 60 seconds old.
3. Attempt a connection and authenticated `vscode-mcp/hello` probe using that record.
   The complete connect-and-handshake probe has a 3-second deadline.
4. Treat a successful authenticated handshake as live even if the heartbeat is old.
5. If the probe fails, re-read the registry path and compare the complete validated
   record with the originally read record.
6. Delete only the registry record when it is byte-for-byte unchanged and still stale.

Cleanup MUST NOT unlink or replace the endpoint. A changed record cancels deletion. PID
liveness may inform diagnostics but never replaces the authenticated probe. A
future-dated heartbeat is not stale and SHOULD produce a safe diagnostic without
exposing the record contents.

## Connection and handshake state machine

Each accepted connection is in exactly one of these states:

```text
AwaitingHello -> Ready -> Closing -> Closed
       |           |
       +---------->+
          failure
```

The extension allows at most four simultaneous IPC connections per window. A fifth
connection is closed without parsing application requests. Every accepted connection
starts a 3-second handshake deadline.

### Hello request

The first complete JSON-RPC message MUST be this request:

```ts
type HelloParams = {
  protocolVersion: number; // Integer 1..65,535; may be unsupported.
  toolContractVersion: string; // Bounded semantic version; may be unsupported.
  instanceId: string; // UUID.
  authToken: string; // Exact 43-character token.
  client: {
    name: 'vscode-mcp-bridge';
    version: string; // 1..64 characters.
  };
};
```

Handshake validation is deliberately two-phase and ordered:

1. Parse only the bounded structural fields needed to authenticate. Do not branch on the
   claimed protocol or tool-contract version yet.
2. Verify the instance ID and compare the decoded 32-byte token in constant time. A
   malformed or wrong-length token is compared against a same-length dummy value so that
   failure behavior does not disclose which credential field was wrong.
3. On a missing, late, malformed, repeated, or unauthenticated hello, return at most one
   JSON-RPC application error with code `-31000` and message `Authentication failed`,
   without error data, then close. Oversized or unparseable frames may be closed without
   a response.
4. Only after authentication succeeds, compare `protocolVersion` and
   `toolContractVersion`. A mismatch returns application code `-31000`, message
   `Protocol version mismatch`, and bounded error data with stable internal code
   `PROTOCOL_VERSION_MISMATCH` or `TOOL_CONTRACT_VERSION_MISMATCH` containing only the
   received and supported version values, then closes.
5. Re-check that the instance is currently trusted, enabled, local, and serving the same
   canonical workspace fingerprint. Failure returns an authenticated hello error and
   closes without exposing workspace content or paths.
6. Return `HelloResult` and transition to `Ready`.

```ts
type HelloResult = {
  protocolVersion: 1;
  toolContractVersion: '1.0.0';
  workspaceFingerprint: string;
  instance: {
    instanceId: string;
    displayName: string;
    trusted: true;
    publishedAt: string;
    workspaceFileUri: string | null;
    workspaceFolders: Array<{
      workspaceFolderId: string;
      name: string;
      uri: string;
    }>;
    protocolVersion: 1;
    toolContractVersion: '1.0.0';
  };
  capabilities: {
    extensionTools: ExtensionToolName[];
    cancellation: true;
  };
};
```

The returned instance ID, protocol versions, workspace folder IDs, and safe workspace
metadata MUST agree with the authenticated record where fields overlap. The bridge
discards the record if they disagree.

## Extension capabilities

Protocol v1 defines exactly 38 extension-backed tools in the canonical order recorded by
[`V1_ALL_EXTENSION_TOOL_NAMES`](../packages/protocol/src/tool-schemas-v1.ts): the ten
original extension tools, three bounded workspace read/search tools, capability status,
eight additive language tools, nine mutation tools, and seven task/debug tools. The
public 39th tool is bridge-owned `list_instances`.

`list_instances` is intentionally absent. It is a bridge-owned MCP tool implemented from
discovery plus successful authenticated handshakes. The bridge MUST NOT forward it
through `vscode-mcp/callTool`.

The capability array MUST contain only those names, without duplicates, and in canonical
order. The bridge registers or invokes only advertised tools. An additional, unknown,
duplicated, or reordered name is a compatibility failure. The 1.0 release gate requires
the complete 38-tool array. Capability names never grant authorization; write and
execution remain independent extension-owned session state.

## Tool calls

`vscode-mcp/callTool` is valid only in `Ready` state and has this envelope:

```ts
type CallToolParams = {
  tool: ExtensionToolName;
  arguments: ToolArgumentsFor<typeof tool>; // Strict schema; no instanceId.
};

type CallToolResult =
  | {
      outcome: 'success';
      observedAt: string;
      truncated: boolean;
      warnings: Warning[];
      payload: {
        tool: ExtensionToolName;
        result: RawToolResultFor<typeof tool>;
      };
    }
  | {
      outcome: 'toolError';
      tool: ExtensionToolName;
      error: ToolExecutionError;
    };
```

The bridge validates MCP arguments before forwarding them. It consumes the public
`instanceId` selector and MUST NOT include it in `arguments`; the authenticated
connection already identifies the target instance. The extension treats `arguments` as
untrusted and validates the exact selected tool schema again before invoking a VS Code
API.

The extension MUST reject a tool not present in the fixed capability set. It MUST
re-check trust, enablement, workspace identity, URI scheme, canonical containment, and
document version at call time. Provider-returned locations receive the same containment
check before serialization.

The extension applies the tool's count and content limits, deterministic truncation
order, and warnings. The bridge validates the tool-tagged raw result, verifies that its
tool matches the in-flight request, and creates the public `Success<T>` by adding the
contract version and selected instance ID. It then independently enforces the maximum
512 KiB serialized MCP success payload before writing to `stdout`.

## Capacity, queueing, deadlines, and cancellation

The fixed scheduling limits are:

| Resource                    | Limit |
| --------------------------- | ----: |
| Connections per window      |     4 |
| Active calls per connection |     4 |
| Active calls per window     |     8 |
| Queued calls per window     |    16 |

The queue limit counts waiting calls, not the eight active slots. Calls are admitted in
window-wide FIFO order while respecting the four-active-per-connection limit. A call
that would become the seventeenth waiting call receives a tool failure with code
`SERVER_BUSY`; it is never executed.

Deadlines start when the extension receives a valid `callTool` request and include time
spent in the queue:

- `get_editor_context`, `read_document`, and `get_diagnostics` have a 5-second simple
  operation deadline.
- `get_hover`, `get_definition`, `find_references`, `get_document_symbols`,
  `search_workspace_symbols`, `get_signature_help`, and `get_call_hierarchy` have a
  15-second provider-operation deadline.

The diagnostics quiet-period wait is part of its 5-second deadline. A queued request
whose deadline expires is removed without execution and returns tool error `TIMEOUT`. An
active timeout requests provider cancellation where supported, discards every late
result, and returns one `TIMEOUT` client outcome. Queued work releases immediately. An
active operation releases its execution slot exactly once only when its original host
promise settles, even when that promise cannot be cancelled.

Cancellation uses the standard notification:

```ts
type CancelParams = {
  id: number; // Nonnegative safe integer of an active or queued callTool request.
};
```

The bridge sends `$/cancelRequest` only for a request issued on the same connection. The
extension removes a queued request or signals the active cancellation token. An unknown
or already completed ID is ignored. Completion before the absolute deadline wins only if
no client-terminal event already won; otherwise the terminal result is tool error
`CANCELLED` or `TIMEOUT`. Exactly one client response is emitted. Closing a connection
cancels its client/queued accounting immediately. Any non-cancellable active execution
remains in the per-connection/window counters until its raw promise settles, so closing
and reconnecting cannot recycle capacity into detached work.

## Authenticated session close

Normal bridge cleanup after a successful authenticated hello uses one final
`vscode-mcp/closeSession` request. Pre-authentication failures, malformed frames,
transport loss, and already closed sockets use the force-close fallback instead.

```ts
type CloseSessionParams = Record<string, never>; // Strict empty object.
type CloseSessionResult = { closed: true };
```

`closeSession` is valid exactly once in `Ready`. Before returning, the extension
registers the exact request ID with the bounded writer, validates strict empty params,
transitions to `Closing`, and returns the strict acknowledgement. Only after the full
matching response frame's write callback succeeds does it end the server-side socket.
After the socket emits `finish`, the extension cancels residual connection work, clears
request tracking, removes the session from the four-connection admission set, and
destroys the server-side socket. This does not release an underlying call-execution slot
early; a non-cancellable host promise still consumes window capacity until settlement.

The bridge strictly validates the acknowledgement and then waits up to three seconds for
peer socket close. Peer close is the completion barrier proving that extension-side
admission cleanup happened before another session is opened. A missing, malformed, or
late acknowledgement fails closed through the bounded transport teardown path. A
pre-authentication `closeSession` receives only the generic authentication failure.
Malformed params receive `Invalid params` only after authentication. Repeated close
requests never create a second live session or release another connection's slot.

## IPC errors and tool failures

JSON-RPC errors and public tool failures have different meanings and MUST NOT be
interchanged.

### IPC errors

IPC errors describe framing, envelope, handshake, or connection-state failures. They use
standard JSON-RPC errors where applicable:

- `-32700` Parse error
- `-32600` Invalid Request
- `-32601` Method not found
- `-32602` Invalid params for the internal method envelope
- `-32603` Internal IPC handler error
- `-31000` Bounded vscode-mcp application or transport error

Before authentication, only generic `-31000` / `Authentication failed` without data is
permitted when a response is safe. After authentication, `-31000` error data contains a
stable internal code, a fatal flag, and at most 16 allowlisted scalar details. It MUST
contain no token, endpoint, PID, canonical or absolute path, environment value, source
text, request body, provider output, or stack trace. Framing violations normally close
without an error response.

The bridge maps loss of an authenticated connection to the appropriate public instance
failure, normally `INSTANCE_DISCONNECTED`; it never forwards raw IPC errors or error
data to the model.

### Tool failures

Expected failures while validating or executing a supported tool are successful JSON-RPC
responses with `outcome: 'toolError'` and a bounded `ToolExecutionError`. This includes
`INVALID_ARGUMENT`, `SERVER_BUSY`, `WORKSPACE_UNTRUSTED`, containment and document
failures, provider availability, `TIMEOUT`, `CANCELLED`, and a sanitized
`INTERNAL_ERROR` raised within tool execution.

The bridge wraps a tool failure in the public versioned `Failure` payload and maps it to
an MCP tool result with `isError: true`. It preserves the stable public error code and
sanitized payload, but does not expose internal IPC codes. Invalid `CallToolParams` is
an IPC `-32602`; valid params containing invalid public tool arguments produce tool
failure `INVALID_ARGUMENT`.

## Discovery and pinned CLI selection

Registry discovery is an untrusted input phase. The bridge size-bounds and validates
records, applies the pinned CLI selector, performs stale handling, then authenticates
each candidate. Metadata is eligible for use only after a successful hello whose
instance identity matches the record.

CLI selectors are lifetime upper bounds, not authorization:

- `--instance <uuid>` permits only that exact instance. Disconnecting it never causes
  failover to another instance.
- `--workspace <absolute-path>` permits only instances whose authenticated canonical
  workspace roots contain that canonical path according to the ADR 0002 deepest-root
  rule.
- When no explicit selector is supplied, canonical bridge `cwd` and then the
  single-eligible-instance rule may select an instance.
- A public tool's `instanceId` may narrow the pinned candidate set but can never expand
  it or override a CLI selector.
- Multiple remaining candidates produce `INSTANCE_AMBIGUOUS`; there is no last-focused,
  first-record, or most-recent fallback.

For usability across an unexpected listener restart, the bridge may retain at most 64
authenticated instance-to-workspace identities in memory for 60 seconds. If a caller
requests a recently observed missing instance and exactly one currently authenticated,
in-bound instance has the same canonical workspace identity, `INSTANCE_NOT_FOUND` may
include the safe scalar detail `replacementInstanceId`. The bridge never redirects the
call automatically, never emits a hint for an instance-pinned bridge, and emits no hint
when identity is unknown, expired, out of bound, or ambiguous. This cache contains no
token, endpoint, content, or persistent alias and is not authorization; listener restart
still revokes write/execution grants.

The bridge considers at most 64 valid instance records in one discovery result. If the
validated candidate set exceeds that upper bound, it fails closed with a bounded error
rather than choosing a partial winner.

Instance IDs are the only explicit per-window selector. Protocol v1 has no persistent,
user-assigned, workspace-derived, or friendly aliases. Two windows for the same
workspace require an explicit `instanceId`; omission remains ambiguous.

## `list_instances` ownership

`list_instances` is registered at the MCP bridge and never invokes
`vscode-mcp/callTool`. It returns only safe metadata obtained from currently successful,
authenticated hello responses that also satisfy the pinned CLI upper bound.

It MUST exclude malformed, unsupported-version, unauthenticated, stale-and-unreachable,
disabled, untrusted, remote, virtual, and out-of-bound records. It MUST NOT return or
derive PIDs, tokens, endpoints, canonical paths, fingerprints, registry paths, or
authentication failure detail. Results are capped at 64 instances and sorted
deterministically by instance ID after authentication.

The resolution summary may report `explicit`, `cwd`, `single`, `none`, or `ambiguous`,
but an ambiguity exposes only candidate instance IDs and safe authenticated metadata.

## Lifecycle

### Extension lifecycle

1. On activation, generate a window-lifetime instance ID but do not start IPC merely
   because the extension loaded.
2. Confirm local VS Code Desktop, Workspace Trust, at least one local workspace folder,
   and explicit enablement for the canonical workspace fingerprint.
3. Create or verify secure runtime directories, generate a new 32-byte token and 16-byte
   endpoint entropy, bind the listener, and begin accepting connections.
4. Only after the listener is ready, atomically publish the registry record and begin
   5-second heartbeat replacement.
5. Authenticate every connection and enforce all connection, call, queue, deadline,
   cancellation, and output limits.
6. On disablement, trust loss, workspace-folder-set change, extension-host shutdown, or
   listener failure: stop accepting; reject new work; cancel queued and active work;
   close connections; compare-delete the owned record; close the listener; remove only
   the extension-owned Unix socket; and discard the token.
7. Re-enablement starts a new listener with a new endpoint and token. A changed
   workspace fingerprint requires a new explicit enablement decision.

### Bridge lifecycle

1. Parse and canonicalize CLI selectors once. They remain pinned upper bounds for the
   process lifetime.
2. Discover only secure, bounded registry records and apply the stale-record algorithm.
3. Authenticate candidates before selection or disclosure.
4. For an instance-bound tool, resolve exactly one authenticated instance, complete the
   hello handshake, verify capabilities, and issue `callTool`.
5. Never silently reconnect a call to a different instance. A lost selected connection
   fails outstanding work as `INSTANCE_DISCONNECTED`; a later MCP call resolves again
   only within the original pinned upper bound.
6. After every normally completed authenticated probe or tool session, send
   `vscode-mcp/closeSession`, validate its acknowledgement, and wait for peer close
   before opening the next session. Failed authentication and broken transports use the
   bounded force-close fallback.
7. Propagate MCP cancellation to `$/cancelRequest`. On MCP client shutdown, cancel
   outstanding calls and close every IPC connection without changing live registry
   records.

## Protocol invariants and required negative tests

Implementation is conformant only when tests cover at least:

- 8 KiB headers and rejection at 8 KiB plus one byte;
- 256 KiB bridge frames, 2 MiB extension frames, and rejection at each limit plus one;
- negative, fractional, string, duplicate, unknown, and overflowing request IDs;
- missing hello, repeated hello, token length and token mismatch, timeout at 3 seconds,
  and proof that version detail appears only after authentication;
- strict authenticated `closeSession`, generic pre-authentication failure, malformed
  params, repeated close, acknowledgement-before-admission-release ordering, peer-close
  timeout, and six rapid sequential sessions without exhausting the four-slot limit;
- strict registry parsing, 64 KiB record limit, symlink/owner/permission rejection, and
  atomic replacement without partial reads;
- heartbeat at 5 seconds, non-staleness before 60 seconds, successful stale probe,
  failed 3-second probe, and compare-delete losing a heartbeat race;
- four versus five connections, four versus five active calls per connection, eight
  versus nine active calls per window, and queue depth 16 versus 17;
- queue-inclusive 5-second and 15-second deadlines, cancellation before start,
  cancellation during a provider request, and completion/cancellation races;
- canonical capability validation, a complete 38-extension-tool 1.0 gate, and rejection
  of `list_instances` over IPC;
- the 512 KiB MCP success-result boundary and explicit tool-contract truncation;
- duplicate windows, pinned selector non-expansion, ambiguity, and no failover or alias
  fallback;
- trust loss, disablement, workspace fingerprint change, shutdown, and token rotation.

Tests MUST assert that failures do not log or return credentials, endpoints, absolute
paths, source content, request bodies, or provider output.
