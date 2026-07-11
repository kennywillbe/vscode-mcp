# ADR 0005: Bounded read and discovery tools

- Status: Accepted and integrated into the 1.0 contract by ADR 0007
- Date: 2026-07-11
- Accepted: 2026-07-11
- Scope: Bounded read/discovery design now shipped in 1.0

The maintainer later moved this scope into the first complete 1.0 release. References
below to a post-1.0 sequence describe the decision history, not the active release plan.

## Context

The accepted 1.0 surface exposes live editor state and language intelligence but has no
workspace file discovery, literal text search, or batch document read. Coding agents
therefore fall back to host filesystem or shell tools, lose dirty-buffer visibility for
search, and spend one MCP round trip per known document.

These capabilities expand read volume and workspace-structure exposure but do not add a
write authority. Combining their acceptance with unresolved write-grant UX in ADR 0004
would unnecessarily block an independently reviewable read-only increment.

Official API review and Extension Host spikes established that stable
`workspace.findFiles` is suitable for bounded discovery, stable VS Code has no public
`findTextInFiles` API in the supported range, and an extension-owned literal scanner is
feasible under fixed candidate, byte, concurrency, cancellation, and output budgets.
Phase A traces against two repositories exposed and corrected an underinclusive
generated-directory policy without raising those budgets.

## Decision

Introduce exactly three additive read-only tools in the proposed
`vscode-mcp.tools/0.2.0` contract:

1. `list_workspace_files`
2. `read_documents`
3. `search_workspace_text`

The detailed wire shapes and limits live in
[`../tool-contract-v0.2.md`](../tool-contract-v0.2.md). The security delta and test gate
live in [`../security-model-v0.2-read.md`](../security-model-v0.2-read.md) and the
[`../security-acceptance-report-1.0.md`](../security-acceptance-report-1.0.md) evidence.

### Authority and scope

- The extension remains the sole workspace authorization authority.
- Every call selects exactly one authenticated instance and one explicit
  `workspaceFolderId`; no new tool spans folders implicitly.
- Every discovered or requested document is canonicalized and reauthorized in the
  extension at call time.
- The deepest canonical workspace root owns a file in nested-root workspaces.
- Symlink candidates are omitted, including aliases that resolve inside the workspace;
  external aliases never disclose their target or relative name.
- Losing trust, read enablement, workspace identity, or the listener generation
  invalidates active work and continuation cursors. Ordinary per-call IPC reconnects do
  not invalidate a cursor while the same listener generation remains eligible.

### Discovery policy

- Candidate discovery uses stable `workspace.findFiles` with a folder-bound
  `RelativePattern`.
- The contract owns a deterministic generated/dependency/cache default and never
  silently inherits `.gitignore`, `.ignore`, `files.exclude`, or `search.exclude`.
- An omitted caller `exclude` uses the default, a string is brace-unioned with the
  default, and `null` disables all exclusions.
- Disabling exclusions never raises resource ceilings. Generated content should be
  requested with `null` and a narrow `include`.
- The default is a performance and predictability policy, not a secret-classification
  boundary. Explicitly enabling a workspace authorizes its otherwise eligible files;
  filenames such as `.env` are not implicitly protected by this glob.

### Batch reads

- `read_documents` preserves v0.1 live-buffer, version, line-range, and containment
  behavior for each item.
- Read-only siblings may succeed independently; caller order and duplicate inputs are
  preserved.
- Aggregate content and serialized-result budgets can stop later items with the stable
  `BATCH_BUDGET_EXHAUSTED` item error. No sibling source or path is included in an
  error.

### Literal search

- Search is literal-only. It does not invoke a shell, subprocess, arbitrary command,
  proposed API, or private VS Code object.
- Discovery selects candidates first; authorized live text overrides disk bytes only for
  the same canonical candidate.
- Closed files are preflighted, bounded, binary/UTF-8 checked, read through a shared
  two-slot per-window scheduler, and verified against post-read file state.
- Changed, removed, binary, invalid, unsupported, symlinked, and oversized candidates
  are omitted with bounded aggregate warnings and no path disclosure.
- Optional context is removed before match locations when output pressure occurs.

### Pagination and cursors

- Caller page limits use `hasMore` and `nextCursor` without pretending that ordinary
  pagination is exceptional truncation.
- Safety-ceiling or unsupported-item omissions remain explicit
  truncation/incompleteness.
- The extension creates and verifies opaque HMAC-authenticated cursors with a random key
  owned by the current listener generation. Cursors bind the contract, tool, instance,
  workspace, folder, resolved policy, query/options, and last sort position.
- Cursor payloads store a bounded continuation offset and hash of the last sort tuple,
  not a potentially 4,096-character relative path.
- Cursors are continuations, not snapshots or authorization grants. Every resumed call
  repeats authorization, and workspace changes may shift page membership.

### Compatibility

- The eleven accepted v0.1 tools and their inputs remain unchanged.
- Bridge and extension negotiate the contract exactly; mixed 0.1/0.2 pairs fail closed.
- New tools are advertised only by a matching 0.2 pair.
- All three tools remain read-only, non-destructive, and closed-world. MCP annotations
  describe behavior but do not enforce it.

## Consequences

- Agents can discover and search the editor-authorized workspace and batch known reads
  without acquiring shell or write authority.
- Search observes unsaved live text and returns structured UTF-16 positions.
- Native `rg` remains faster and often terser for persisted-only content; this feature
  is justified by editor state, authorization, and structured completeness semantics.
- The extension owns more filesystem work and must maintain deterministic glob,
  scheduling, cursor, decoding, and resource-limit code.
- Default exclusions reduce accidental generated-tree scans but do not classify or hide
  secrets from an already authorized MCP client.

## Rejected alternatives

- Wait for a proposed/private VS Code text-search API.
- Spawn ripgrep, a shell, task, terminal, or arbitrary VS Code command.
- Trust bridge-side path filtering or MCP roots as authorization.
- Silently inherit editor settings or repository ignore files.
- Replace the complete default when a caller adds one small exclude glob.
- Treat a cursor as a workspace snapshot or authorization token.
- Raise traversal ceilings to accommodate generated output.
- Couple read-only implementation acceptance to unresolved write-grant UX.

## Acceptance scope

This ADR was accepted together with the v0.2 read security model, acceptance evidence,
and frozen contract. Acceptance authorizes schema and implementation work for these
three read-only tools only. It does not accept ADR 0004, enable writes, or alter the 1.0
release candidate.
