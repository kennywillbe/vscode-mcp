# Security acceptance evidence report for the local 1.0 candidate

> This file is the inherited transport/read baseline and preserves its review history.
> The complete 39-tool product disposition is in
> `security-acceptance-report-v1.0-full-ide.md`; later full-surface evidence supersedes
> stale candidate-count and final-gate statements below.

- Review date: 2026-07-10
- Reviewed contracts: `vscode-mcp.ipc/1`, `vscode-mcp.security/0.1`, and the accepted
  Milestone 1 security acceptance criteria
- Executed review platforms: macOS and a clean Linux container, using POSIX Unix-domain
  sockets
- Gate result: **source acceptance passed for the supported macOS/Linux matrix; final
  artifact and post-freeze security acceptance remain open**

This report records the executable evidence for the local candidate. Version 1.0
supports standard local VS Code Desktop on macOS and Linux. Windows is explicitly
unsupported and fails closed before publication; its reserved future enablement rows are
not represented as passes or included in the 1.0 acceptance denominator.

## Result summary

The current source and earlier artifact snapshot have the following execution evidence:

- a clean temporary macOS working copy performed a fresh frozen install and passed 36
  test files / 356 tests, formatting, lint, workspace typechecks, production builds, and
  the high-severity dependency audit on Node.js `22.21.1` and pnpm `10.24.0`;
- after that full-suite checkpoint, the expanded `E-IPC` file passed 19/19 focused tests
  with extension typecheck and lint green, including the real-socket terminal-winner
  matrix for `M1-CAN-004`;
- a clean Linux `amd64` container used exact Node.js `22.13.0` and pnpm `10.24.0`,
  verified the pnpm standalone binary against its official release-asset SHA-256,
  performed `pnpm install --frozen-lockfile`, and passed audit, the complete
  36-file/356-test check, and production builds;
- the expanded eight-test extension-host suite passed on macOS with both stable VS Code
  `1.128.0` and the minimum supported VS Code `1.101.0`;
- before the final three host tests were added, the complete five-test suite also passed
  five consecutive stable runs and two consecutive minimum-version runs;
- runtime instrumentation exercised the real bundled bridge child process with the real
  IPC service across success, internal failure, timeout, cancellation, authentication
  failure, cleanup, and arbitrary-command rejection; and
- the release suite covers deterministic archives, checksums, manifests, SBOM
  generation, and license inclusion, while the remaining archive/metadata verifier gaps
  are tracked as Milestone 5 blockers; and
- an earlier installed VSIX plus separately extracted server archive passed the complete
  eight-scenario host suite on macOS and clean Linux `amd64`, with both VS Code
  `1.101.0` and stable. That artifact snapshot predates later source changes and is not
  the final candidate.

The post-scan hardening suite also proves numeric-index raw provider limits, nested
diagnostic/hover/signature/call-range limits, sparse and cap-plus-one access behavior,
bounded cyclic/deep symbol traversal, and separate client-versus-execution scheduler
settlement. Repeated cancellation, disconnect, and timeout waves cannot start a ninth
underlying operation while eight original provider promises remain pending.

Across the 68 criteria applicable to version 1.0, this audit classifies **51 as
Pass-local, 17 as Pass-unit, 0 as Partial, and 0 as Unmet**. Five reserved future
Windows-enablement rows are separately documented and are neither passed nor counted.

The final executable coverage includes registry fallback and exact-boundary tests,
non-regular and unsafe registry entries, listener fail-closed behavior, real
multi-client 8-active/16-queued admission, queued cancellation, service-stop cleanup,
authenticated `closeSession` accounting, host-level workspace/symlink/URI/editor and
provider filtering/races, dynamic workspace-fingerprint withdrawal, authenticated
arbitrary-dispatch rejection, disable and token rotation, process-level network and
filesystem instrumentation, strict spawned-bridge stdout/stderr checks, live registry
authentication/probe boundaries, and every distinct first-terminal request-lifecycle
winner over a real socket. The production eligibility function additionally exercises
every supported/unsupported OS, trust, local/remote, Desktop/Web, sandbox,
absent-folder, virtual, untitled, and mixed-scheme branch without treating a synthetic
environment as a supported runtime run.

## Formal repository scan and remediation

The frozen pre-remediation source was reviewed by the standard Codex Security repository
workflow under scan ID `unversioned_20260710T031811Z` and snapshot digest
`codex-security-snapshot/v1:sha256:b8854be2a2734000c5d45aaa9f1d85f80b4adebd092829f2b49aacf9ee6e7fd6`.
The sealed result contained one high-confidence low-severity finding and no medium,
high, or critical finding: cancellation/timeout/disconnect released scheduler admission
before a non-cancellable provider promise settled. Three environment-specific
observations remained outside the supported runtime review: future Windows ACL support,
Windows path-case behavior on real NTFS, and production editor-state cardinality
measurement.

The current source remediates the reported scheduler finding by separating prompt client
settlement from actual execution settlement and by retaining the raw provider, stat, and
document-open promises through cancellation. Active capacity now releases only after the
original promise settles. It also replaces every reviewed pre-limit provider traversal
with numeric-index raw budgets and bounds editor/document/tab wrapping before
allocation. Regression tests exercise the scheduler together with the real language-tool
service, not only an isolated mock promise. The sealed scan remains an immutable
observation of the earlier snapshot. A post-freeze scan must be executed as a final
read-only delivery step and identified outside this tree so recording its identity
cannot mutate the snapshot it covers.

## Evidence catalog

The short evidence names in the matrix refer to these executable files:

| Name       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P-FRAME`  | [bounded-jsonrpc.test.ts](../packages/protocol/src/bounded-jsonrpc.test.ts)                                                                                                                                                                                                                                                                                                                                                        |
| `P-IPC`    | [ipc-schemas.test.ts](../packages/protocol/src/ipc-schemas.test.ts)                                                                                                                                                                                                                                                                                                                                                                |
| `P-CRED`   | [credentials.test.ts](../packages/protocol/src/credentials.test.ts)                                                                                                                                                                                                                                                                                                                                                                |
| `P-HS`     | [handshake.test.ts](../packages/protocol/src/handshake.test.ts)                                                                                                                                                                                                                                                                                                                                                                    |
| `P-REG`    | [runtime-registry.test.ts](../packages/protocol/src/runtime-registry.test.ts) and [registry-schemas.test.ts](../packages/protocol/src/registry-schemas.test.ts)                                                                                                                                                                                                                                                                    |
| `S-STDIO`  | [bounded-stdio-transport.test.ts](../packages/server/src/bounded-stdio-transport.test.ts) and [transport-hardening.test.ts](../packages/server/src/transport-hardening.test.ts)                                                                                                                                                                                                                                                    |
| `S-FRAME`  | [ipc-framing.acceptance.test.ts](../packages/server/src/ipc-framing.acceptance.test.ts)                                                                                                                                                                                                                                                                                                                                            |
| `S-INPUT`  | [input-selection.acceptance.test.ts](../packages/server/src/input-selection.acceptance.test.ts)                                                                                                                                                                                                                                                                                                                                    |
| `S-IPC`    | [ipc-client.test.ts](../packages/server/src/ipc-client.test.ts)                                                                                                                                                                                                                                                                                                                                                                    |
| `S-SELECT` | [instance-selection.test.ts](../packages/server/src/instance-selection.test.ts)                                                                                                                                                                                                                                                                                                                                                    |
| `S-REG`    | [local-instance-registry.test.ts](../packages/server/src/local-instance-registry.test.ts) and [stale-cleanup.security.test.ts](../packages/server/src/stale-cleanup.security.test.ts)                                                                                                                                                                                                                                              |
| `S-AUTH`   | [registry-auth.acceptance.test.ts](../packages/server/src/registry-auth.acceptance.test.ts)                                                                                                                                                                                                                                                                                                                                        |
| `S-LOG`    | [bridge-process-logging.acceptance.test.ts](../packages/server/src/bridge-process-logging.acceptance.test.ts)                                                                                                                                                                                                                                                                                                                      |
| `S-SDK`    | [sdk-adapter.test.ts](../packages/server/src/sdk-adapter.test.ts)                                                                                                                                                                                                                                                                                                                                                                  |
| `E-IPC`    | [ipc-instance-service.unit.test.ts](../packages/extension/src/ipc-instance-service.unit.test.ts)                                                                                                                                                                                                                                                                                                                                   |
| `E-IPC-H`  | [ipc-instance-service.security.unit.test.ts](../packages/extension/src/ipc-instance-service.security.unit.test.ts)                                                                                                                                                                                                                                                                                                                 |
| `E-FRAME`  | [ipc-framing.acceptance.unit.test.ts](../packages/extension/src/ipc-framing.acceptance.unit.test.ts)                                                                                                                                                                                                                                                                                                                               |
| `E-SCHED`  | [request-scheduler.unit.test.ts](../packages/extension/src/request-scheduler.unit.test.ts) and the scheduler/service integration in [language-tool-service.unit.test.ts](../packages/extension/src/language-tool-service.unit.test.ts)                                                                                                                                                                                             |
| `E-AUTHZ`  | [workspace-authorizer.unit.test.ts](../packages/extension/src/workspace-authorizer.unit.test.ts)                                                                                                                                                                                                                                                                                                                                   |
| `E-ID`     | [workspace-identity.unit.test.ts](../packages/extension/src/workspace-identity.unit.test.ts)                                                                                                                                                                                                                                                                                                                                       |
| `E-ELG`    | [workspace-eligibility.unit.test.ts](../packages/extension/src/workspace-eligibility.unit.test.ts)                                                                                                                                                                                                                                                                                                                                 |
| `E-TOOLS`  | [provider-output-bounds.unit.test.ts](../packages/extension/src/provider-output-bounds.unit.test.ts), [editor-tool-service.unit.test.ts](../packages/extension/src/editor-tool-service.unit.test.ts), [language-tool-service.unit.test.ts](../packages/extension/src/language-tool-service.unit.test.ts), and [language-location-tool-service.unit.test.ts](../packages/extension/src/language-location-tool-service.unit.test.ts) |
| `E-OUTPUT` | [output-hardening.unit.test.ts](../packages/extension/src/output-hardening.unit.test.ts)                                                                                                                                                                                                                                                                                                                                           |
| `E-ROUTER` | [extension-tool-router.unit.test.ts](../packages/extension/src/extension-tool-router.unit.test.ts)                                                                                                                                                                                                                                                                                                                                 |
| `E-HOST`   | [extension.test.ts](../packages/extension/src/test/extension.test.ts)                                                                                                                                                                                                                                                                                                                                                              |
| `RUNTIME`  | [runtime-security.instrumentation.unit.test.ts](../packages/extension/src/runtime-security.instrumentation.unit.test.ts) and [runtime-security-preload.mjs](../packages/extension/src/test-support/runtime-security-preload.mjs)                                                                                                                                                                                                   |
| `STATIC`   | [security-surface.static.test.ts](../packages/server/src/security-surface.static.test.ts)                                                                                                                                                                                                                                                                                                                                          |
| `RELEASE`  | [release-lib.test.mjs](../scripts/release-lib.test.mjs)                                                                                                                                                                                                                                                                                                                                                                            |
| `CI`       | [ci.yml](../.github/workflows/ci.yml), configuration only until a hosted runner executes it                                                                                                                                                                                                                                                                                                                                        |

Status meanings:

- **Pass-local:** the complete stated behavior has repeatable executable evidence on the
  supported local macOS/Linux POSIX boundary.
- **Pass-unit:** the accepted unit boundary is covered and passed.
- **Partial:** useful evidence exists, but the accepted boundary or exhaustive cases are
  missing.
- **Unmet:** adequate executable evidence does not exist, or an accepted-contract
  conflict prevents a pass.

## Eligibility and lifecycle

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                                        |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-ELG-001 | Pass-local | `E-HOST` proves an explicitly enabled local trusted workspace publishes exactly one instance and one registry record, and that the bridge discovers and serves it.                                                                                 |
| M1-ELG-002 | Pass-unit  | `E-ELG` exhausts the production eligibility branches; `E-HOST` proves absence of explicit enablement and later disablement publish no instance or metadata through the real lifecycle.                                                             |
| M1-ELG-003 | Pass-unit  | `E-ELG` fails closed for Remote SSH, WSL, Dev Containers, Codespaces, Web, virtual/mixed/untitled workspaces, Snap, Flatpak, Windows, and an unknown OS before publication or fallback.                                                            |
| M1-ELG-004 | Pass-local | `E-HOST` disables MCP while a provider call is active and proves a disconnected result, no canary leak, record removal, and empty discovery. `E-IPC` proves active-plus-queued stop cleanup, and `E-IPC-H` proves fresh credentials after restart. |
| M1-ELG-005 | Pass-local | `E-HOST` changes the canonical folder set in a real multi-root host, proves the old record/instance is withdrawn and discovery remains empty, then requires explicit enablement and publishes a new instance ID while the old record stays absent. |
| M1-ELG-006 | Pass-local | `E-IPC-H` restarts the listener, proves endpoint and token rotation, rejects the old credential pair generically, and accepts only the new pair.                                                                                                   |

## IPC framing and envelopes

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                       |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-FRM-001 | Pass-local | `E-FRAME` sends a valid request byte by byte across every header/body boundary, proves no early dispatch, and observes exactly one dispatch after the final byte.                                                 |
| M1-FRM-002 | Pass-local | `E-FRAME` sends coalesced hello and tool frames in one real-socket write and proves each is reconstructed once in wire order.                                                                                     |
| M1-FRM-003 | Pass-unit  | `P-FRAME` accepts an exact 8 KiB header and rejects 8 KiB plus one before body allocation.                                                                                                                        |
| M1-FRM-004 | Pass-local | `E-FRAME` dispatches an exact 256 KiB application frame, rejects plus one without dispatch, and proves a later healthy real-socket client remains usable.                                                         |
| M1-FRM-005 | Pass-local | `S-FRAME` receives an exact 2 MiB framed response through the actual bridge client, treats plus one as disconnected without exposure, and reconnects successfully.                                                |
| M1-FRM-006 | Pass-local | `E-FRAME` repeats all nine accepted malformed `Content-Length` variants over real sockets, with no dispatch or echo, attacker-only close, and healthy-client recovery.                                            |
| M1-FRM-007 | Pass-local | `P-FRAME` covers invalid UTF-8, JSON, scalar/array, version, and envelope forms; `E-IPC-H` sends malformed data to the real service and authenticates a later healthy client, proving isolation and availability. |
| M1-FRM-008 | Pass-unit  | `P-IPC` accepts only `0` and `Number.MAX_SAFE_INTEGER` from the required request-ID matrix and keeps notifications ID-less.                                                                                       |

## Authentication and protocol negotiation

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                               |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-AUT-001 | Pass-local | `E-IPC` and `E-IPC-H` complete a real authenticated hello and validate the actual instance, tool-contract version, and read-only capabilities.                                                                                            |
| M1-AUT-002 | Pass-local | `E-IPC-H` measures a real no-hello connection closing at the canonical three-second deadline, frees its slot, and authenticates a later client.                                                                                           |
| M1-AUT-003 | Pass-local | `E-IPC-H` sends the complete real-socket non-hello first-message table: tool call, cancellation, notification, batch, other method, `closeSession`, and repeated hello. Nothing dispatches and every connection fails closed generically. |
| M1-AUT-004 | Pass-local | `P-HS`, `E-IPC`, and `E-IPC-H` cover malformed, wrong, and stale credentials with the same bounded detail-free failure and connection close.                                                                                              |
| M1-AUT-005 | Pass-unit  | `P-CRED` covers fixed-size secure generation, equal/unequal and differently encoded candidates, malformed encodings, and the constant-time comparison path.                                                                               |
| M1-AUT-006 | Pass-local | `E-IPC-H` proves an authenticated version mismatch returns only bounded version detail and closes, while the same mismatch with a bad token remains generic.                                                                              |
| M1-AUT-007 | Pass-local | `S-AUTH` probes live endpoints across every registry/hello overlap, canonicalizes and verifies roots, rejects each mismatch, and proves a pinned rejected record never falls through to a healthy instance.                               |
| M1-AUT-008 | Pass-unit  | `P-IPC` rejects duplicate, unknown, and out-of-order capabilities; `E-ROUTER` asserts the complete canonical 1.0 capability array.                                                                                                        |
| M1-AUT-009 | Pass-local | `P-FRAME`, `P-IPC`, `E-IPC`, and `E-HOST` cover strict empty `closeSession`, ack-before-peer-close accounting, pre-authentication/malformed/repeated behavior, six rapid sequential sessions, and repeatable stable/minimum host suites.  |

## Registry, runtime directory, and staleness

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                            |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-REG-001 | Pass-local | `P-REG` and `E-IPC` verify 0700 directories and 0600 records/socket on macOS; the same complete suite passed in the clean Linux container.                                                                                             |
| M1-REG-002 | Pass-local | `P-REG` explicitly covers absent, relative, missing, symlinked, foreign-owned, and permissive preferred roots, validates the fallback, and fails closed when a fallback is relative or unsafe.                                         |
| M1-REG-003 | Pass-local | `P-REG` fails closed without repairing two unsafe candidates; `E-IPC` attempts listener startup with both candidates unsafe and proves no record publication, path alteration, or cleanup of the unsafe entries.                       |
| M1-REG-004 | Pass-unit  | `P-REG` constructs, publishes, discovers, and schema-validates an exact 64 KiB record, and rejects plus one before JSON parsing/probing.                                                                                               |
| M1-REG-005 | Pass-unit  | `P-REG` and the strict registry schema reject malformed names, missing/unknown fields, versions, endpoints, tokens, and timestamps before selection.                                                                                   |
| M1-REG-006 | Pass-local | `P-REG` uses real directory, FIFO, and socket entries plus device and foreign-owner seams, and proves unsafe entries are rejected before open/connect and are never altered or deleted.                                                |
| M1-REG-007 | Pass-local | `P-REG` continuously reads during atomic publication/heartbeat replacement and observes only complete records with restrictive permissions preserved.                                                                                  |
| M1-REG-008 | Pass-unit  | `P-REG` and `S-REG` cover all age/reachability combinations, including the exact 60-second boundary: only an old rejected unchanged record is stale.                                                                                   |
| M1-REG-009 | Pass-local | `P-REG` and `S-REG` prove changed bytes preserve a replacement; the probe-race fixture rotates heartbeat, token, and endpoint before compare/delete.                                                                                   |
| M1-REG-010 | Pass-local | `S-REG` proves cleanup removes only the unchanged stale registry record and never unlinks/replaces its endpoint or unrelated sentinels.                                                                                                |
| M1-REG-011 | Pass-local | `P-CRED` keeps the default production path directly backed by `node:crypto`. `E-IPC` injects deterministic entropy across two real listener starts and proves exact 32-byte token and 16-byte endpoint requests, values, and rotation. |
| M1-REG-012 | Pass-local | `S-AUTH` holds a real endpoint probe open for the full three-second deadline, returns a bounded unverified result, and proves the fresh registry record remains present.                                                               |

## Instance and workspace selection

| ID         | Status     | Evidence and remaining gate                                                                                                                                                 |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-SEL-001 | Pass-unit  | `S-SELECT` proves exact instance selection takes precedence over cwd and registry order.                                                                                    |
| M1-SEL-002 | Pass-unit  | `S-SELECT` proves pinned instance/workspace selectors neither fall back nor expand.                                                                                         |
| M1-SEL-003 | Pass-unit  | `S-SELECT` selects only a unique deepest canonical containing root.                                                                                                         |
| M1-SEL-004 | Pass-unit  | `S-SELECT` uses the sole eligible fallback only after cwd has no match.                                                                                                     |
| M1-SEL-005 | Pass-unit  | `S-SELECT` keeps duplicate windows ambiguous and does not use focus, PID, time, or order fallbacks.                                                                         |
| M1-SEL-006 | Pass-local | `S-INPUT` rejects display name, workspace path, workspace-folder ID, root-like value, and fingerprint-shaped aliases passed to `--instance` before resolution.              |
| M1-SEL-007 | Pass-unit  | `S-SELECT` covers nested roots, prefix traps, case-sensitive POSIX, injected case-insensitive Windows semantics, and caller-supplied canonical real paths.                  |
| M1-SEL-008 | Pass-local | `S-AUTH` mixes stale, fresh-unreachable, hello-mismatched, and live records in one discovery and admits only the authenticated live match without exposing unsafe metadata. |

## Workspace scope and read-only authority

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                                    |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-SCP-001 | Pass-local | `E-HOST` sends a fabricated workspace-folder claim through the bridge and proves the extension rejects it against current host authority.                                                                                                      |
| M1-SCP-002 | Pass-local | `E-HOST` proves real symlink escape and path-prefix trap requests are rejected within the VS Code host.                                                                                                                                        |
| M1-SCP-003 | Pass-local | `E-HOST` covers untitled, remote, settings, Git, notebook-cell, output, extension, and virtual URIs and proves the provider is not invoked.                                                                                                    |
| M1-SCP-004 | Pass-local | `E-HOST` registers a real provider returning internal and external locations, exposes only the internal location with the exact omission count, and proves the external URI/path/content canary never escapes.                                 |
| M1-SCP-005 | Pass-local | `E-HOST` opens mixed external and virtual documents/editors/tabs and proves editor context omits their identities and metadata.                                                                                                                |
| M1-SCP-006 | Pass-local | `E-HOST` sends a registered side-effect command as both an authenticated unknown method and forged tool, receives only method/params errors, observes zero command invocations, and then completes a valid read-only call on the same session. |
| M1-SCP-007 | Pass-local | `E-HOST` uses a real provider and proves document edits invalidate stale results; disabling MCP invalidates an active provider result, leaks no canary, removes discovery, and re-enables with a new instance ID.                              |

## Capacity, byte limits, and timeouts

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                 |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-LIM-001 | Pass-local | `S-INPUT` measures serialized tool arguments at the direct-call boundary, accepts exactly 256 KiB, and rejects plus one with a bounded sanitized invalid-params error before IPC.           |
| M1-LIM-002 | Pass-unit  | `E-OUTPUT` tests exact 512 KiB and plus one with deterministic reduction; `S-SDK` independently measures the complete MCP success envelope and fails irreducible overflow.                  |
| M1-LIM-003 | Pass-local | `E-IPC-H` authenticates four real clients, closes the fifth, and proves the existing sessions remain usable.                                                                                |
| M1-LIM-004 | Pass-local | `E-SCHED` and `E-IPC` prove four active calls on one real session and queue the fifth.                                                                                                      |
| M1-LIM-005 | Pass-local | `E-IPC` drives four real clients to eight active and sixteen queued calls; the seventeenth waiting call fails with bounded `SERVER_BUSY` while admitted work remains controlled.            |
| M1-LIM-006 | Pass-local | `E-SCHED` and `E-IPC` prove queue-inclusive 5/15-second deadlines, one prompt client timeout, raw-execution slot retention until settlement, exactly-once release, and late-result discard. |
| M1-LIM-007 | Pass-unit  | Protocol schemas, `E-TOOLS`, and `E-OUTPUT` cover cap-plus-one raw traversal, nested/global collection, content, Unicode, and deterministic explicit-truncation limits.                     |

## Cancellation and request lifecycle

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                                                              |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1-CAN-001 | Pass-local | `E-IPC` sends cancellation through a real socket while a request is queued and proves its handler never starts.                                                                                                                                                          |
| M1-CAN-002 | Pass-local | `E-IPC` sends real JSON-RPC cancellation and observes the matching active handler's `AbortSignal`; unrelated work is unaffected.                                                                                                                                         |
| M1-CAN-003 | Pass-local | `E-SCHED` integrates the real language service with eight non-cooperative provider promises, returns prompt cancellation, keeps all eight execution slots occupied, blocks a ninth start, then discards late values and releases only after raw settlement.              |
| M1-CAN-004 | Pass-local | `E-IPC` runs completion, cancellation, timeout, and disconnect as each distinct first client-terminal winner over a real Unix socket; `E-SCHED` separately proves exactly-once client and raw-execution settlement, delayed-deadline classification, and capacity reuse. |
| M1-CAN-005 | Pass-local | `E-IPC` sends an unknown cancellation ID, leaves the connection usable, and cancels only the later matching operation.                                                                                                                                                   |
| M1-CAN-006 | Pass-local | `E-IPC` cancels active and queued real-socket client work together, `S-IPC` settles a pending bridge call on peer close, `E-HOST` withdraws discovery on disable, and `E-SCHED` proves non-cancellable raw work remains bounded and counted until settlement.            |

## Logging, telemetry, and network absence

| ID         | Status     | Evidence and remaining gate                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-LOG-001 | Pass-local | `RUNTIME` injects source/provider/selection/hover/diagnostic/request/environment/user/path/token/endpoint canaries across success, validation rejection, auth failure, timeout, cancellation, and internal failure, then checks responses, stdout, stderr, console, and artifacts. `E-HOST` also covers provider-disable canaries. |
| M1-LOG-002 | Pass-local | `S-LOG` spawns the bundled bridge with malformed registry data and proves every stdout line is valid MCP JSON-RPC with empty stderr; a separate failing startup emits only the exact sanitized allowlisted stderr message and no stdout.                                                                                           |
| M1-LOG-003 | Pass-local | `STATIC` rejects telemetry/exporter and unapproved mutation surfaces; `RUNTIME` observes child filesystem/network APIs and verifies the isolated runtime fixture is empty after cleanup.                                                                                                                                           |
| M1-NET-001 | Pass-local | `RUNTIME` instruments `net`/TLS/HTTP/HTTP2/UDP listener and connection APIs while the real bridge and extension service run on macOS and clean Linux; only the local Unix socket is bound.                                                                                                                                         |
| M1-NET-002 | Pass-local | `RUNTIME` instruments DNS, HTTP/HTTPS, HTTP2, TLS, UDP, TCP, fetch, WebSocket, EventSource, and child-process APIs across discovery, calls, failures, cancellation, and cleanup; only expected local IPC connections occur.                                                                                                        |

## Windows future-enablement note

Windows is not part of the 1.0 support matrix. The acceptance document preserves these
rows for a future milestone and is explicit that mocks could not satisfy them if Windows
support were proposed. They are not 1.0 blockers and are not counted as passes.

| ID         | Status | Evidence and remaining gate                                                                                                                   |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-WIN-001 | Future | Named-pipe creation is not implemented; a future supported implementation would require a real endpoint/address/entropy test.                 |
| M1-WIN-002 | Future | The pipe is deliberately not published; future support would require owner-versus-distinct-user DACL/access tests.                            |
| M1-WIN-003 | Future | No `%LOCALAPPDATA%` registry DACL/access implementation exists; future support would require real two-account tests.                          |
| M1-WIN-004 | Future | `P-REG` and `E-ELG` already preserve the 1.0 fail-closed behavior; a future Windows release still requires real publication and ACL evidence. |
| M1-WIN-005 | Future | Four-versus-five is proven for the supported POSIX transport; a combined pipe ACL/admission test belongs to a future Windows implementation.  |

## Windows feasibility conclusion

The present fail-closed decision is required, not merely conservative:

- Current
  [Node.js 22 `net.Server.listen` documentation](https://nodejs.org/download/release/latest-v22.x/docs/api/net.html)
  exposes `readableAll` and `writableAll` for IPC endpoints, but no custom Windows
  security descriptor or DACL-verification option.
- Node's current
  [`PipeWrap::Bind`](https://github.com/nodejs/node/blob/v22.x/src/pipe_wrap.cc) passes
  only the pipe name to `uv_pipe_bind2`; JavaScript cannot supply a Windows
  `SECURITY_ATTRIBUTES` value through that binding.
- libuv's current
  [Windows pipe implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)
  calls `CreateNamedPipeW` with a null security-attributes argument. Its documented
  [`uv_pipe_chmod`](https://docs.libuv.org/en/v1.x/pipe.html) operation only makes a
  pipe readable and/or writable by all users; it does not create an owner-only DACL.
- Microsoft documents that a named pipe created with the
  [default security descriptor](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
  grants read access to Everyone and Anonymous in addition to stronger owner/system
  rights.

From those primary sources, this report infers that the accepted owner-only named-pipe
DACL cannot be safely created and verified through the reviewed pure-Node/libuv API
surface. Post-creation `icacls` or PowerShell repair would introduce a creation race,
shell execution, and a new command surface, so it is not an acceptable workaround.

Secure Windows support is feasible only after explicit architectural and dependency
review of one of these approaches:

1. a narrow native Node-API component that creates the pipe with explicit
   `SECURITY_ATTRIBUTES`, verifies the effective DACL with Windows security APIs, and
   safely hands the already-created handle into the event loop; or
2. a separately designed, reviewed native broker/helper owning the pipe and registry ACL
   boundary.

Either option introduces a native component and requires an ADR/security-model update,
supply-chain and license review, real Windows two-account tests, and maintainer
approval. Until then, `WINDOWS_ACL_NOT_IMPLEMENTED` and no registry publication is the
correct behavior. Windows is explicitly unsupported in 1.0; this report neither claims
nor requires Windows runtime support.

## Cross-platform and CI disposition

- A clean macOS working copy passed frozen install, audit, all 36 files/356 tests, and
  production builds. Focused scheduler/provider, real-socket, runtime-instrumentation,
  and full eight-test stable/minimum extension-host evidence also passed locally.
- A clean Linux `amd64` container repeated the exact current source with Node.js
  `22.13.0`, pnpm `10.24.0`, a SHA-256-verified pnpm bootstrap, frozen installation,
  audit, all 36 files/356 tests, production builds, and exact-artifact host runs on both
  supported VS Code bounds. Neither local execution is a GitHub-hosted runner record.
- `CI` configures supported-platform validation and extension-host compatibility axes:
  Linux runs VS Code `1.101.0` and stable, while macOS Intel runs stable. Local Apple
  Silicon evidence covers both versions. Release packaging depends on all matrix jobs
  and performs a reproducibility comparison.
- The private GitHub repository runs the hosted matrix before the separate public,
  release, and Marketplace publication approvals.
- No real Snap or Flatpak compatibility run exists, consistent with those distributions
  remaining explicitly deferred.

## Final candidate disposition

The 1.0-applicable source acceptance rows have no Partial or Unmet result, and future
Windows rows remain outside the supported candidate scope. Milestone 5 nevertheless
remains open until the known TAR/VSIX/SBOM verifier gaps are fixed, artifact-host tests
start from clean state and run in the supported-platform release flow, a current-source
artifact set reproduces byte-for-byte, and the post-freeze formal security scan is
completed. Hosted GitHub Actions execution remains part of the later publication stage
because no remote repository exists yet.
