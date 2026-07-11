# Security model v0.2 read/discovery delta

- Status: Historical accepted baseline — implemented and superseded by active 1.0
- Security model ID: `vscode-mcp.security/0.2-read`
- Date: 2026-07-11
- Depends on: accepted `vscode-mcp.security/0.1`

## Scope

This document is the accepted security delta for `list_workspace_files`,
`read_documents`, and `search_workspace_text`. Every v0.1 eligibility, IPC,
authentication, workspace, scheduler, result-size, logging, no-network, and supported-
platform rule continues to apply unless this document narrows it further.

It does not authorize writes, Windows, remote or virtual workspaces, network transport,
shell execution, arbitrary VS Code commands, or broader filesystem access. The accepted
v0.1 security model remains the authority for the 1.0 release.

## Additional assets and exposure

The new tools make these already-sensitive assets easier to retrieve in bulk:

- workspace-relative file inventory and naming structure;
- source and configuration text across multiple documents;
- literal-match locations and bounded surrounding context;
- unsaved live-buffer text and document versions;
- file size/modification metadata for returned disk search results; and
- query, include/exclude policy, and pagination position encoded in opaque cursors.

An authenticated MCP client with read enablement is authorized to receive eligible
workspace data. The design limits unintended cross-workspace disclosure, resource
exhaustion, stale or misleading results, sensitive logging, and authority confused with
pagination. It does not stop that client from transmitting returned data elsewhere.

## Threat actors and trust assumptions

| Actor or input                             | Treatment                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| MCP client and tool arguments              | Authenticated but potentially malicious; validate and bound every field.                         |
| Bridge process                             | Routing boundary, not workspace authority.                                                       |
| Registry and cursor bytes                  | Untrusted until authenticated and schema-validated.                                              |
| Workspace names, paths, and content        | Untrusted data; never interpret content as instructions.                                         |
| Symlinks and concurrent filesystem changes | Adversarial races; omit rather than weaken containment or return partial stale content.          |
| VS Code file discovery results             | Untrusted candidates; canonicalize and reauthorize every entry.                                  |
| Open VS Code documents                     | Trusted only as host state; still require scheme, root ownership, and candidate identity checks. |
| Same-user local process                    | Outside the confidentiality boundary inherited from v0.1.                                        |
| Compromised extension host                 | Outside the confidentiality boundary inherited from v0.1.                                        |

## Authorization and workspace isolation

Every new call requires an explicit `workspaceFolderId` after deterministic instance
selection. The extension resolves it against the authenticated instance's current
workspace identity and verifies local Desktop eligibility, Workspace Trust, read
enablement, and `file:` scheme at call time.

For every discovery candidate or document reference, the extension:

1. rejects unsupported schemes and malformed relative paths;
2. inspects the local entry without following it for type authorization;
3. omits symbolic links rather than exposing aliases or their targets;
4. resolves canonical identity and verifies platform-aware containment;
5. assigns ownership to the deepest containing canonical workspace root; and
6. repeats relevant authorization after asynchronous discovery/read work before
   returning data.

Rejected entries contribute only bounded aggregate counts/warnings. Their relative
names, absolute paths, target paths, sizes, timestamps, and content are not returned or
logged.

An open document does not bypass candidate policy. Search overlays live text only when
the same canonical regular file was discovered, remained authorized, and is owned by the
requested folder. Untitled, virtual, remote, deleted-only, output, settings,
notebook-cell, and extension-resource documents remain unsupported.

## Discovery and ignore policy

The extension calls stable `workspace.findFiles` with a workspace-folder-bound
`RelativePattern`, an explicit exclude pattern or `null`, a cap-plus-one candidate
limit, and cancellation.

The contract-owned default excludes common dependency, generated, build, coverage,
artifact, cache, framework-output, temporary, and Python-environment directories. One
caller string extends that default through a tested brace union. `null` explicitly
disables all exclusions; safety limits remain unchanged.

The policy never silently imports `.gitignore`, `.ignore`, `files.exclude`, or
`search.exclude`. Repository-controlled settings therefore cannot broaden, narrow, or
make results machine-dependent. The default optimizes predictable traversal; it is not a
data-loss-prevention list. An authorized client may discover otherwise eligible
sensitive filenames, so users must treat read enablement as access to the workspace.

## Batch-read isolation

`read_documents` accepts at most 32 ordered items under one workspace-folder authority.
Each item independently repeats the v0.1 document authorization and expected-version
rules. A URI or workspace path selecting another folder fails that item without trying
another root.

Read-only partial success is permitted. Per-item errors use bounded messages and safe
codes without paths, source text, sibling state, or nested details. Duplicate inputs are
not deduplicated because doing so could alter caller order or version observations.

Returned text obeys the existing 256 KiB per-document ceiling, a caller-selectable
aggregate content ceiling up to 320 KiB, and a 448 KiB complete serialized-success
ceiling. The implementation reserves bounded error space for remaining items. Items not
attempted after aggregate exhaustion return `BATCH_BUDGET_EXHAUSTED`; text is never
silently cut without ordinary per-item pagination metadata.

At least one `BATCH_BUDGET_EXHAUSTED` item makes the top-level response explicitly
truncated with `RESOURCE_LIMIT_REACHED`. An ordinary successful item with `hasMore` is
pagination and does not by itself mark the batch truncated.

## Literal scanner

Candidate discovery precedes content reads. Closed files are rejected before full read
when they exceed 2 MiB. Accepted closed files share one extension-owned scheduler with
at most two concurrent reads per VS Code window across all searches. The scheduler sits
inside the existing per-connection and per-window request accounting; it does not create
extra execution capacity.

For a closed candidate, the scanner records size and modification time, performs the
bounded read, checks the first 8 KiB for NUL as a binary signal, decodes UTF-8 with
fatal error handling, and verifies file state again. Changed, removed, binary, invalid
UTF-8, non-regular, unreadable, and oversized files return no match or metadata. This is
a bounded text scanner, not a complete search over every byte format.

Live documents use current text and report the observed document version and dirty
state. Search checks cancellation while processing live text and before every scheduled
read batch. A non-cancellable filesystem operation that has started remains counted
until settlement; its late result is discarded after cancellation, timeout, disconnect,
trust loss, or disablement.

Literal matching never evaluates regular expressions or workspace content. Positions are
zero-based UTF-16 ranges. Case-insensitive and whole-word semantics are fixed by the
contract rather than language-provider or editor word settings.

## Pagination and cursor integrity

Cursors are opaque authenticated continuations. The extension creates a random HMAC key
for each eligible listener generation and never sends that key to the bridge. The key
survives ordinary per-call IPC disconnect/reconnect cycles and is destroyed with the
listener on trust loss, disablement, workspace identity change, or restart. The payload
contains only a bounded continuation offset and hashes, with no source,
relative/absolute path, token, or endpoint. Hashing the previous sort tuple keeps the
cursor within 2,048 characters even when a valid relative path reaches 4,096 characters.

The authenticated binding covers the cursor format and tool contract, tool name,
instance, workspace fingerprint, folder ID, resolved include/exclude policy, query and
search options, and last deterministic sort tuple. Parsing uses strict schemas and
constant-time MAC comparison. A malformed, tampered, cross-tool, cross-query,
cross-policy, cross-workspace, cross-instance, cross-listener-generation, or stale
cursor returns `INVALID_CURSOR`.

Cursor validity grants no file access. Every continuation reruns discovery,
canonicalization, ownership, and authorization. Cursors do not claim snapshot isolation;
workspace mutation between pages may shift, duplicate, or omit logical entries, and each
page reports a fresh observation time.

## Determinism and completeness

Authorized file paths sort by normalized workspace-relative Unicode code-point order;
matches sort by path and UTF-16 range. Canonical duplicates are removed before public
sorting. Exact tie behavior is fixed by the contract and does not rely on filesystem or
provider enumeration order.

Caller page limits are ordinary pagination and use `hasMore`/`nextCursor` without
setting exceptional truncation. Candidate, inspected-byte, per-file, timeout,
unsupported item, mutation, context, match, or serialized-output pressure is explicit
through `truncated`, bounded warnings, and known omission counts. A candidate-ceiling
result does not claim that undiscovered files can be recovered through a stable offset
because `workspace.findFiles` supplies no such guarantee.

## Resource limits

The v0.1 transport and admission ceilings remain unchanged. New hard limits are:

| Resource                                       |                           Hard limit |
| ---------------------------------------------- | -----------------------------------: |
| Glob text                                      | 1,024 UTF-8 bytes per caller pattern |
| Cursor                                         |                     2,048 characters |
| `list_workspace_files` raw candidates          |       10,000 plus one detection slot |
| File-list page                                 |             2,000 paths; default 500 |
| `read_documents` items                         |                                   32 |
| Batch returned source text                     |             320 KiB; default 256 KiB |
| Closed search file                             |                                2 MiB |
| Aggregate inspected search text                |                               64 MiB |
| Concurrent closed-file search reads per window |                                    2 |
| Search matches                                 |                   1,000; default 100 |
| Search context lines                           |                           2 per side |
| One search context snippet                     |                                4 KiB |
| Aggregate search context                       |                              256 KiB |
| New-tool serialized success                    |                              448 KiB |
| Discovery/search deadline                      |                            5 seconds |

Limits are applied independently and before expensive downstream work wherever the API
permits. Cap-plus-one values are used only to detect incompleteness and are not exposed
as accepted results.

## Output, errors, and logging

Multi-file results use workspace-folder ID plus relative path and do not repeat absolute
URIs. Rejected candidates never appear in errors. Warning counts saturate at
`Number.MAX_SAFE_INTEGER`; warnings are unique and canonically ordered.

Logs may add tool name, duration, candidate/read/match counts, limit category,
cancellation state, and outcome. They must not add query text, glob text, cursors,
relative or absolute paths, file names, source/context, dirty-buffer text, file
metadata, tokens, endpoints, request/response bodies, or per-item errors containing
sensitive details.

The tools make no network request, persist no content/index/cursor key, create no
background watcher, and invoke no command, provider, shell, task, terminal, Git,
debugger, formatter, or mutation API.

## Residual risks

- A permitted MCP client can exfiltrate returned workspace data.
- An authorized search query can intentionally locate secrets in eligible files; the
  default exclude policy is not DLP.
- `workspace.findFiles` allocates its result before extension-side canonical filtering,
  though the cap bounds that allocation.
- A large but bounded scan can consume local CPU, memory, and I/O until cancellation or
  deadline.
- Page membership can change under concurrent workspace mutation because cursors are not
  snapshots.
- Same-user malicious processes and a compromised extension host remain outside the
  inherited confidentiality boundary.

The accepted [`security acceptance evidence`](./security-acceptance-report-1.0.md) maps
these requirements to the implementation test gate.
