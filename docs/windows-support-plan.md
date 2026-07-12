# Windows desktop support plan

- Status: Planned; not part of 1.0
- Depends on: separate maintainer approval and a new Windows transport ADR
- Current behavior: fail closed before listener or registry publication

Windows support is a security-boundary project, not a path-separator patch. The macOS/
Linux runtime proves user-only registry directories and Unix sockets with filesystem
ownership and modes. A Windows release must establish and verify the equivalent owner
SID and DACL properties before publishing any endpoint.

## Phase W0 — Feasibility and transport decision

1. Prototype two narrow options: a signed native Node addon that creates named pipes
   with an explicit security descriptor, and a small signed per-user broker exposing a
   fixed local protocol.
2. Obtain the interactive user's SID without PowerShell, `icacls`, shell execution, or
   post-creation ACL repair.
3. Prove owner-only registry-directory and pipe creation before the endpoint becomes
   discoverable.
4. Read back and validate owner, integrity level, protected DACL, and effective access.
5. Reject TCP loopback, random-name-as-authorization, default-DACL assumptions, and any
   weak-permission publication window.

Exit: an accepted ADR selects one boundary with a small auditable native surface,
reproducible build inputs, and no fallback to weaker transport.

## Phase W1 — Protocol and lifecycle implementation

- Add a Windows runtime-registry strategy under the existing process boundary; keep MCP
  stdio and exact version matching unchanged.
- Define the named-pipe endpoint schema, canonical Windows path/case rules, SID-bound
  registry layout, atomic record publication, heartbeat, stale cleanup, token rotation,
  and crash recovery.
- Keep authentication tokens and constant-time comparison even with correct ACLs.
- Preserve fail-closed Workspace Trust, local Desktop, `file:` workspace, remote/web/
  virtual rejection, write grant, and execution grant behavior.
- Ensure uninstall and extension shutdown remove only endpoints proven to be owned by
  this exact process generation.

Exit: all current protocol and tool tests pass through the Windows strategy without
platform conditionals leaking into tool services.

## Phase W2 — Adversarial Windows acceptance

Required real-machine tests:

- owner account can discover, authenticate, call all 39 tools, revoke grants, and clean
  up after normal exit and crash;
- a distinct unprivileged local account cannot read registry records/tokens, connect to
  the pipe, replace the endpoint, or delete owner records;
- same-user malicious processes without the token fail authentication;
- pre-created pipe names, junctions, symlinks, reparse points, case confusion, UNC and
  device paths, long paths, alternate data streams, malformed frames, cancellation,
  concurrent clients, and stale PID/name reuse fail safely;
- multi-window selection, multi-root deepest ownership, dirty buffers, multi-document
  writes, configured tasks, and named debug operate identically to macOS/Linux; and
- effective ACL verification fails closed when inheritance or policy changes produce a
  broader descriptor than expected.

Exit: owner and cross-account negative suites pass on supported Windows 11 images with
no unresolved high-severity finding.

## Phase W3 — Supply chain, packaging, and CI

- Reproducibly build the native component for x64 and arm64 from pinned sources.
- Generate provenance, hashes, SBOM nodes, licenses/notices, and code signatures.
- Package it only inside the version-matched GitHub Release pair; no installer service,
  auto-updater, Marketplace channel, or PATH mutation.
- Add pinned Windows CI for unit, real named-pipe integration, Extension Host, packaged
  VSIX/server/native-pair, clean install, upgrade, downgrade, and removal.
- Run a manual cross-account acceptance job because hosted single-user CI is not enough
  evidence for the ACL boundary.

Exit: the exact signed artifacts pass reproducibility and clean-machine tests.

## Phase W4 — Promotion gates

Windows can enter the support matrix only when:

1. the transport ADR, security-model delta, and acceptance criteria are accepted;
2. the native code has an independent focused review;
3. owner and distinct-account tests are attached to one source/artifact snapshot;
4. documentation describes supported Windows/VS Code/Node versions and removal;
5. no shell or weaker IPC fallback exists; and
6. the maintainer explicitly approves a post-1.0 release version.

Until then, `WINDOWS_ACL_NOT_IMPLEMENTED` remains the required behavior. Version 1.0
must not create or publish a Windows listener or registry record, and must not fall back
to TCP, a default-DACL named pipe, shell-based ACL repair, or random-name authorization.
