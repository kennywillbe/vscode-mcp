# MCP tool contract v0.2

- Status: Historical accepted baseline — implemented and superseded by active 1.0
- Contract ID: `vscode-mcp.tools/0.2.0`
- Scope: Local, trusted VS Code workspaces on the existing macOS/Linux boundary

This document defines the first three agent-oriented read tools accepted after 1.0. It
does not change the accepted `vscode-mcp.tools/0.1.0` contract or make unimplemented
tools available. Its acceptance authorizes executable schema and implementation work
under ADR 0005 and the v0.2 read security gate.

## Compatibility

Version 0.2 is additive at the MCP surface:

- all eleven v0.1 tool names keep their v0.1 inputs and behavior;
- the three tools in this draft are advertised only by a bridge/extension pair that
  agrees on contract 0.2;
- contract negotiation remains exact rather than assuming that semver implies wire
  compatibility; and
- a v0.1 client or release artifact never sees the new tools.

The three proposed tools are read-only and use the same extension-owned workspace,
trust, path, cancellation, scheduling, logging, and `stdio -> IPC` boundaries as v0.1.
Their MCP annotations are `readOnlyHint: true`, `destructiveHint: false`, and
`openWorldHint: false`; annotations are not enforcement.

## Accepted inventory

1. `list_workspace_files`
2. `read_documents`
3. `search_workspace_text`

Write authorization and write-tool schemas are deliberately outside this draft. They
remain blocked on the remaining ADR and security gates.

## Shared conventions

### Workspace scope

Every call selects one instance using the existing optional `instanceId` rules and then
requires one `workspaceFolderId`. A call never spans workspace folders implicitly. A
client repeats a call for each selected folder.

The extension resolves the folder ID at call time, verifies trust and enablement, and
reauthorizes every candidate. Nested roots use the existing deepest-containing-root
ownership rule. A file owned by a nested workspace folder is not returned while scanning
its parent folder.

### Deterministic glob policy

Discovery inputs share this shape:

```ts
type DiscoveryPolicy = {
  include?: string; // Default "**/*".
  exclude?: string | null; // Additional exclusion, or null to disable all exclusions.
};
```

`include` and a string `exclude` use VS Code `RelativePattern` glob syntax, are scoped
to the selected workspace folder, and are each limited to 1,024 UTF-8 bytes. Empty,
untrimmed, absolute, backslash-containing, NUL-containing, or parent-traversing patterns
are invalid.

`exclude` has three deliberately distinct states:

- omitted: use the contract default
  `**/{.git,node_modules,dist,out,build,coverage,artifacts,.vscode-test,.next,.open-next,.sst,.wrangler,.turbo,.cache,.parcel-cache,.nuxt,.output,.tmp,__pycache__,.venv}/**`;
- string: exclude the union of the complete contract default and that additional
  pattern; and
- `null`: apply no exclusion pattern.

The tools do not silently inherit `.gitignore`, `.ignore`, `files.exclude`, or
`search.exclude`. The extension always passes an explicit exclude value or `null` to
stable `workspace.findFiles`; it never passes `undefined`. A caller string is combined
with the default as a brace union before discovery. Nested brace patterns remain valid,
as verified in the stable Extension Host spike. Disabling exclusions does not raise any
safety ceiling; callers that need generated content should use `null` with a narrow
`include`.

### Compact document identity

New multi-file results avoid repeating absolute `file:` URIs. A compact identity is
sufficient because the extension has already authorized the selected folder and path:

```ts
type WorkspaceDocument = {
  workspaceFolderId: string;
  relativePath: string; // Forward slashes; no absolute path or "..".
};
```

Single-document v0.1 tools retain their existing full `DocumentSnapshot`; this draft
does not change them.

### Pagination versus incomplete work

Caller-requested pages are normal results:

```ts
type Page = {
  hasMore: boolean;
  nextCursor: string | null;
};
```

`hasMore` may be true while top-level `truncated` is false. It means the requested page
is complete and another page is available. `truncated: true` is reserved for an
independent safety ceiling, unsupported candidate, mutation race, or output reduction
that made the logical scan incomplete. Such a response includes a bounded warning.

### Opaque cursors

Cursors are at most 2,048 characters and contain no source text, absolute path, token,
or endpoint. They are created and verified by the extension with a random key scoped to
the current listener generation and bind at least:

- contract and cursor-format versions;
- selected instance, workspace fingerprint, and workspace-folder ID;
- normalized include/exclude policy;
- tool-specific query and options; and
- a continuation offset and hash of the last returned deterministic sort tuple.

A cursor cannot be moved between tools, queries, policies, workspaces, instances, or
listener generations. It remains usable across the bridge's ordinary per-call IPC
disconnect/reconnect cycle while that listener generation remains eligible. Listener
restart, trust loss, disablement, or workspace identity change destroys the key and
invalidates it. Tampered, expired, or mismatched cursors return `INVALID_CURSOR`.
Retrying without the cursor starts a fresh scan. The bridge never becomes the authority
for cursor integrity or workspace continuation.

Cursors are continuations, not workspace snapshots. If files change between calls, later
pages may omit, duplicate, or shift entries relative to the earlier observation. Each
result reports its own `observedAt`; the contract never claims snapshot isolation. On an
unchanged workspace the offset resumes strictly after the hashed tuple. The hash keeps
even a maximum-length relative path out of the 2,048-character cursor rather than
weakening the 4,096-character workspace-path contract.

### New warnings and errors

The v0.1 warning order remains unchanged. Version 0.2 appends:

- `RESOURCE_LIMIT_REACHED`: a candidate, byte, time, or scan-work ceiling prevented a
  complete result;
- `FILES_CHANGED_DURING_REQUEST`: one or more candidates changed or disappeared after
  discovery and were omitted.

Existing `CONTENT_TRUNCATED` is used when optional context is reduced before matches.
Existing `UNSUPPORTED_ITEMS_OMITTED` covers non-regular, binary, invalid UTF-8,
oversized, unsupported-scheme, or otherwise unreadable candidates without returning
their identities. Existing `RESULTS_TRUNCATED` covers a hard public-result or serialized
response ceiling, not an ordinary caller page.

A v0.2 response contains at most one warning per code in canonical order and therefore
at most seven warnings. Repeated omissions aggregate into a saturating `omittedCount`
when that count is known.

Version 0.2 adds these stable execution codes:

- `INVALID_CURSOR`: the continuation is malformed, unauthenticated, expired, or bound to
  different inputs;
- `BATCH_BUDGET_EXHAUSTED`: a `read_documents` item was not attempted because the
  request's aggregate budget was already exhausted.

Batch item errors use the same stable error-code vocabulary but do not turn successful
siblings into a tool-level failure.

## `list_workspace_files`

Returns deterministic, authorized workspace-relative file paths without reading file
content.

```ts
type Input = {
  instanceId?: string;
  workspaceFolderId: string;
  include?: string; // Default "**/*".
  exclude?: string | null; // Additional exclusion, or null to disable all exclusions.
  limit?: number; // Default 500; maximum 2,000.
  cursor?: string;
};

type Result = {
  workspaceFolderId: string;
  files: string[]; // Authorized relative paths in ordinal path order.
  hasMore: boolean;
  nextCursor: string | null;
};
```

Rules:

- discover with stable `workspace.findFiles` and a folder-bound `RelativePattern`;
- request at most 10,001 raw candidates to detect the 10,000-candidate safety ceiling;
- accept only canonical regular `file:` resources owned by the selected root;
- deduplicate by canonical identity before sorting;
- sort by normalized relative path using Unicode code-point ordinal order;
- return paths after the cursor offset, with the previous path represented only by its
  authenticated sort-tuple hash; and
- never return size, timestamps, absolute paths, URIs, or metadata for rejected entries.

If raw discovery reaches 10,001 candidates, only the first 10,000 may be inspected and
the result is explicitly incomplete. `workspace.findFiles` does not provide a stable
offset cursor, so a candidate-ceiling response cannot claim that all later files are
reachable by pagination.

## `read_documents`

Reads several already-known documents in one bounded call while preserving v0.1 live
buffer and line-range behavior.

```ts
type ReadDocumentsItem = {
  document: DocumentRef;
  expectedDocumentVersion?: number;
  startLine?: number; // Default 0.
  lineCount?: number; // Default 500; maximum 2,000.
};

type Input = {
  instanceId?: string;
  workspaceFolderId: string;
  documents: ReadDocumentsItem[]; // 1 to 32 items.
  contentByteLimit?: number; // Default 256 KiB; maximum 320 KiB.
};

type CompactDocumentSnapshot = WorkspaceDocument & {
  languageId: string;
  documentVersion: number;
  isDirty: boolean;
};

type ItemSuccess = {
  outcome: 'success';
  document: CompactDocumentSnapshot;
  eol: 'LF' | 'CRLF';
  totalLineCount: number;
  returnedRange: Range;
  text: string;
  hasMore: boolean;
  nextStartLine: number | null;
};

type ItemError = {
  outcome: 'error';
  error: {
    code: ErrorCode | 'BATCH_BUDGET_EXHAUSTED';
    message: string; // Maximum 512 characters; never contains a path or source text.
    retryable: boolean;
  };
};

type Result = {
  workspaceFolderId: string;
  items: Array<ItemSuccess | ItemError>; // Same length and order as input.
};
```

Rules:

- reject an input whose document reference does not select the requested workspace
  folder rather than silently crossing scope;
- authorize and snapshot each item independently in caller order;
- preserve dirty-buffer precedence, expected-version checks, UTF-16 ranges, and the
  existing 256 KiB per-document text ceiling;
- permit partial success because this is a read-only batch;
- do not retry, reorder, deduplicate, or collapse repeated inputs; and
- do not expose one item's sensitive details through another item's error.

The aggregate returned text is capped by `contentByteLimit`. The complete serialized
success payload is additionally capped at 448 KiB, leaving headroom below the existing
512 KiB MCP ceiling. Before reading each later item, the implementation reserves room
for a bounded error record for every remaining input. When content or serialized-byte
headroom is exhausted, that and all later unattempted items return
`BATCH_BUDGET_EXHAUSTED`. Text is never silently cut merely to fit the batch; a caller
can retry that item with a narrower line range or in a separate call. Any
`BATCH_BUDGET_EXHAUSTED` item makes the top-level response explicitly truncated and adds
`RESOURCE_LIMIT_REACHED`; ordinary per-item `hasMore` pagination does neither.

## `search_workspace_text`

Searches literal text through an extension-owned bounded scanner. It does not run `rg`,
a shell, a VS Code command, or a proposed/private API.

```ts
type Input = {
  instanceId?: string;
  workspaceFolderId: string;
  query: string; // Trimmed; 1 to 256 Unicode scalar values.
  caseSensitive?: boolean; // Default true.
  wholeWord?: boolean; // Default false.
  include?: string; // Default "**/*".
  exclude?: string | null; // Additional exclusion, or null to disable all exclusions.
  contextLines?: number; // Per side; default 0; maximum 2.
  limit?: number; // Matches per page; default 100; maximum 1,000.
  cursor?: string;
};

type SearchDocumentState =
  | {
      source: 'live';
      documentVersion: number;
      isDirty: boolean;
    }
  | {
      source: 'disk';
      sizeBytes: number;
      modifiedAt: string; // RFC 3339 UTC derived from the verified file stat.
    };

type SearchMatch = {
  range: Range;
  context: null | {
    range: Range;
    text: string;
    highlightRange: Range; // Relative to context.text.
  };
};

type Result = {
  workspaceFolderId: string;
  query: string;
  documents: Array<{
    document: WorkspaceDocument;
    state: SearchDocumentState;
    matches: SearchMatch[];
  }>;
  returnedMatchCount: number;
  hasMore: boolean;
  nextCursor: string | null;
};
```

Search behavior:

- matching is literal; regular expressions are not accepted;
- case-insensitive matching uses ECMAScript Unicode `ignoreCase` behavior while
  preserving UTF-16 match indices;
- whole-word boundaries are deterministic Unicode text boundaries, not language-server
  or VS Code editor word settings: letters, combining marks, decimal digits, connector
  punctuation, and join controls are word characters;
- an authorized open text document is scanned from its live buffer, even when dirty;
- otherwise the scanner reads the authorized regular file and verifies size and
  modification state before and after reading;
- invalid UTF-8, binary, non-regular, changed, removed, and oversized inputs are omitted
  with bounded warnings rather than partially decoded;
- documents sort by relative path and matches by start/end range; grouping does not
  alter that global order; and
- on unchanged content, a cursor resumes strictly after the last returned path/range
  tuple using its offset and authenticated tuple hash.

Initial hard ceilings per call:

| Resource                                | Hard ceiling |
| --------------------------------------- | -----------: |
| Raw discovered candidates               |       10,000 |
| Closed file bytes                       |        2 MiB |
| Aggregate inspected source bytes        |       64 MiB |
| Concurrent closed-file reads per window |            2 |
| Public matches                          |        1,000 |
| Context lines per side                  |            2 |
| One context snippet                     |        4 KiB |
| Aggregate context text                  |      256 KiB |
| Serialized success payload              |      448 KiB |
| Operation deadline                      |          5 s |

The scanner checks cancellation before scheduling every bounded read batch and while
processing live text. Optional context is removed before a match location. If the
requested page limit is reached with more authorized matches available, `hasMore` is
true without marking the response truncated. If a candidate, byte, time, unsupported-
item, mutation, or serialized-response ceiling prevents complete work, the response is
explicitly truncated/incomplete even when it also carries a continuation cursor.

## Implementation gates

Before these accepted tools become product behavior:

1. Preserve the completed Phase A trace evidence and remeasure implemented behavior.
2. Add executable Zod schemas, canonical constants, warning/error ordering, and schema
   tests in `packages/protocol`.
3. Keep ADR 0005, the v0.2 read security-model delta, and its acceptance criteria
   synchronized with implementation.
4. Add extension-host tests for dirty buffers, nested roots, symlink escapes, glob
   states, binary/encoding handling, mutation races, cancellation, every independent
   ceiling, cursor tampering/restart, and deterministic repetition.
5. Add bridge tests for exact contract negotiation, result-byte accounting, and v0.1
   isolation.
6. Re-run agent traces against the packaged bridge/extension pair before freezing the
   contract.

The constants and shapes in this document are frozen contract decisions. The isolated
extension implementation and v0.2 IPC composition seam now exist, but product behavior
must not be advertised until the remaining promotion gates pass.

The protocol-only executable schemas live in
`packages/protocol/src/tool-schemas-v0.2.ts`. They are exported through the explicit
`@vscode-mcp/protocol/tool-schemas-v0.2` subpath rather than the active protocol root.
The current runtime constant, handshake, capabilities, and registered tool inventory
remain on v0.1 until a separately verified promotion step.

The proposed security gate is defined by
[`ADR 0005`](./adr/0005-read-discovery-tools.md), the
[`v0.2 read security-model delta`](./security-model-v0.2-read.md), and the
[`v0.2 read acceptance criteria`](./security-acceptance-criteria-v0.2-read.md). ADR 0004
remains the separate authority for future write capability.

The final implementation evidence is summarized in
[`agent-workflow-benchmarks.md`](./agent-workflow-benchmarks.md). Discovery and search
remain editor-aware authorization features rather than raw performance replacements for
native `rg`.
