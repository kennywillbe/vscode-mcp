# MCP tool contract v0.1

- Status: Accepted
- Contract ID: `vscode-mcp.tools/0.1.0`
- Scope: Local, trusted, read-only VS Code workspaces

The executable schemas live in `packages/protocol/src/tool-schemas.ts`. Documentation
and schemas are one contract and must change together.

## Tool inventory

Version 0.1 exposes exactly eleven tools:

1. `list_instances`
2. `get_editor_context`
3. `read_document`
4. `get_diagnostics`
5. `get_hover`
6. `get_definition`
7. `find_references`
8. `get_document_symbols`
9. `search_workspace_symbols`
10. `get_signature_help`
11. `get_call_hierarchy`

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`, and
`openWorldHint: false`. These are descriptive MCP hints; the extension still enforces
read-only behavior and workspace scope.

## Shared conventions

```ts
type Position = {
  line: number; // Zero-based.
  character: number; // Zero-based UTF-16 code-unit offset.
};

type Range = {
  start: Position;
  end: Position; // Exclusive.
};

type DocumentRef =
  | { kind: 'uri'; uri: string }
  | {
      kind: 'workspacePath';
      workspaceFolderId: string;
      relativePath: string;
    };

type DocumentSnapshot = {
  uri: string;
  workspaceFolderId: string;
  relativePath: string; // Always uses "/" separators.
  languageId: string;
  documentVersion: number;
  isDirty: boolean;
};

type Warning = {
  code:
    | 'RESULTS_TRUNCATED'
    | 'CONTENT_TRUNCATED'
    | 'EXTERNAL_LOCATIONS_OMITTED'
    | 'UNSUPPORTED_ITEMS_OMITTED'
    | 'PROVIDER_RETURNED_NO_RESULT';
  message: string;
  omittedCount?: number;
};

type Success<T> = {
  contractVersion: '0.1.0';
  instanceId: string | null;
  observedAt: string; // RFC 3339 UTC.
  truncated: boolean;
  warnings: Warning[];
  result: T;
};
```

A response contains at most one warning per warning code, in the code order shown above.
Repeated omissions are aggregated into `omittedCount`, so a response has at most five
warnings.

Every instance-bound tool accepts an optional `instanceId`. When omitted, the bridge
uses the resolution rules in ADR 0002. Instance and workspace-folder IDs are opaque and
stable only for the lifetime of a VS Code window.

`--instance` or `--workspace` on the bridge command line establishes an upper scope. A
per-call `instanceId` may refine an unpinned bridge selection but can never override a
pinned scope; a conflicting value returns `INVALID_ARGUMENT` without trying another
window.

### Document rules

- Version 0.1 accepts only local `file:` documents under a selected workspace root.
- A workspace-relative path cannot be empty or absolute, contain `..`, or use
  backslashes.
- The extension canonicalizes and `realpath`-checks every target. The deepest containing
  root owns a file when workspace roots are nested.
- Untitled documents, notebook cells, settings editors, output panels, virtual Git
  documents, remote URIs, and out-of-workspace files are excluded.
- An already-open document is read from the live VS Code buffer, including unsaved
  changes.
- Inspecting a closed document may activate a language provider but never reveals the
  document, saves it, or mutates it.

### Positions and versions

- Lines and characters are zero-based.
- Character offsets use UTF-16 code units, matching VS Code and LSP.
- Ranges are half-open and a position at end-of-line is valid.
- A position beyond the line or document returns `POSITION_OUT_OF_RANGE`.

Document/position tools accept `expectedDocumentVersion?: number`. A mismatch returns
`DOCUMENT_VERSION_MISMATCH`. The extension checks again after a provider request; if the
buffer changed during the call, it discards the result and returns
`DOCUMENT_CHANGED_DURING_REQUEST`.

### Provider traversal and nested collection limits

VS Code and installed extensions allocate provider return values before `vscode-mcp`
receives them. After that boundary, the extension reads provider-owned arrays only by
numeric index and stops at the raw budgets below before mapping, sorting, searching,
slicing, spreading, or public-schema validation. A cap-plus-one property is never read.

| Surface                         |                                                              Raw inspection budget |                                                           Public result budget |
| ------------------------------- | ---------------------------------------------------------------------------------: | -----------------------------------------------------------------------------: |
| Open text documents             |                                                                              8,000 |                                    200 documents for open-document diagnostics |
| Diagnostics                     |                                                                  8,000 per request |                                                    caller limit, maximum 2,000 |
| Diagnostic tags                 |                                                                   8 per diagnostic |                                                               2 per diagnostic |
| Related diagnostic information  |                                              128 per diagnostic; 8,000 per request |                                           32 per diagnostic; 2,000 per request |
| Hover                           |                     20 entries; 256 contents per entry; 1,024 contents per request |       20 entries; 64 contents per entry; 256 contents per request; 64 KiB text |
| Definition/declaration variants |                                                                      800 locations |                                                      caller limit, maximum 200 |
| References                      |                                                                    4,000 locations |                                                    caller limit, maximum 1,000 |
| Document symbols                |                                                             8,000 nodes; depth 128 |                                    caller limit, maximum 2,000 flattened nodes |
| Workspace symbols               |                                                                      2,000 symbols |                                                      caller limit, maximum 500 |
| Signature help                  |                                        20 signatures; 100 parameters per signature |                       20 signatures; 100 parameters per signature; 64 KiB text |
| Call hierarchy                  | 40 roots; 1,000 calls per direction; 1,000 ranges per call and 4,000 per direction | 10 roots; 250 calls per direction; 250 ranges per call and 1,000 per direction |

Raw-budget, public-limit, malformed, external, and content omissions are aggregated into
the applicable bounded warning. Omission arithmetic saturates at
`Number.MAX_SAFE_INTEGER`; it never wraps or emits an unsafe JSON integer.

## Tools

### `list_instances`

Lists safe metadata for eligible VS Code instances. It never returns PIDs, socket
addresses, or authentication tokens.

```ts
type Input = {};

type Result = {
  instances: Array<{
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
    toolContractVersion: '0.1.0';
  }>;
  resolution: {
    selectedInstanceId: string | null;
    method: 'explicit' | 'cwd' | 'single' | 'none' | 'ambiguous';
    candidateInstanceIds: string[];
  };
};
```

Hard limit: 64 instances.

### `get_editor_context`

Returns accessible live editor state without leaking metadata for unsupported or
out-of-workspace tabs.

```ts
type Input = {
  instanceId?: string;
  documentLimit?: number; // Default 100, maximum 200.
  tabLimit?: number; // Default 100, maximum 200.
};

type Selection = {
  anchor: Position;
  active: Position;
  start: Position;
  end: Position;
};
```

The result contains the active accessible editor, selections, visible ranges, accessible
visible editors, accessible open text documents, and flattened tab metadata:

```ts
type EditorState = {
  document: DocumentSnapshot;
  selections: Selection[];
  visibleRanges: Range[];
};

type Result = {
  activeEditor: EditorState | null;
  visibleEditors: EditorState[];
  openDocuments: DocumentSnapshot[];
  tabs: Array<{
    groupIndex: number;
    active: boolean;
    pinned: boolean;
    preview: boolean;
    dirty: boolean;
    document: DocumentSnapshot;
  }>;
  omitted: {
    editors: number;
    documents: number;
    tabs: number;
  };
};
```

Unsupported and out-of-workspace entries contribute only to `omitted` counts; their
labels, paths, and URIs are not returned.

Caps: 32 selections and 32 visible ranges per editor.

### `read_document`

Reads a bounded line range from the live text document.

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  expectedDocumentVersion?: number;
  startLine?: number; // Default 0.
  lineCount?: number; // Default 500, maximum 2,000.
};

type Result = {
  document: DocumentSnapshot;
  eol: 'LF' | 'CRLF';
  totalLineCount: number;
  returnedRange: Range;
  text: string;
  hasMore: boolean;
  nextStartLine: number | null;
};
```

The returned text is capped at 256 KiB UTF-8 and never splits a Unicode code point. A
closed file larger than 10 MiB is rejected before opening. An already open larger
document remains readable in bounded chunks.

### `get_diagnostics`

Returns diagnostics for one document or all accessible open documents.

```ts
type Input = {
  instanceId?: string;
  document?: DocumentRef;
  expectedDocumentVersion?: number; // Only valid with document.
  severities?: Array<'error' | 'warning' | 'information' | 'hint'>;
  includeRelatedInformation?: boolean; // Default true.
  limit?: number; // Default 500, maximum 2,000.
};

type Diagnostic = {
  range: Range;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source: string | null;
  code: { value: string; targetUri: string | null } | null;
  tags: Array<'unnecessary' | 'deprecated'>;
  relatedInformation: Array<{
    uri: string;
    range: Range;
    message: string;
  }>;
};

type Result = {
  coverage: 'requested_document' | 'open_documents';
  freshness: {
    state: 'settled' | 'changing' | 'unknown';
    heuristic: true;
    quietPeriodMs: number;
    waitedMs: number;
    lastChangeAt: string | null;
  };
  documents: Array<{
    document: DocumentSnapshot;
    diagnostics: Diagnostic[];
  }>;
};
```

Freshness is a heuristic: snapshot diagnostics, observe relevant change events, wait for
300 ms of quiet with a 1,500 ms maximum, and then read again. `settled` never claims
that a provider analyzed the whole project. External related locations are omitted.
Results sort by URI, severity, range, and message. Each diagnostic and related-
information message is capped at 16 KiB UTF-8. The freshness wait is contained within
the five-second diagnostics timeout. Open-document coverage returns at most 200
authorized documents; omitted documents are reported explicitly.

### `get_hover`

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  position: Position;
  expectedDocumentVersion?: number;
};

type Result = {
  document: DocumentSnapshot;
  hovers: Array<{
    range: Range | null;
    contents: Array<{
      kind: 'markdown' | 'plaintext';
      value: string;
    }>;
  }>;
};
```

Caps: 20 hover entries, 64 contents per entry, 256 contents across the response, and 64
KiB combined text. Markdown and command links are returned as inert text and never
executed.

### `get_definition`

Normalizes VS Code `Location` and `LocationLink` provider results.

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  position: Position;
  expectedDocumentVersion?: number;
  kind?: 'definition' | 'declaration' | 'typeDefinition' | 'implementation';
  limit?: number; // Default 50, maximum 200.
};

type Result = {
  document: DocumentSnapshot;
  kind: Input['kind'];
  locations: Array<{
    uri: string;
    targetRange: Range;
    targetSelectionRange: Range;
    originSelectionRange: Range | null;
  }>;
};
```

Exact duplicates are removed and external targets are omitted with a warning.

### `find_references`

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  position: Position;
  expectedDocumentVersion?: number;
  includeDeclaration?: boolean; // Default false.
  contextLines?: number; // Default 0, maximum 2.
  limit?: number; // Default 200, maximum 1,000.
};

type Result = {
  document: DocumentSnapshot;
  references: Array<{
    uri: string;
    range: Range;
    context: {
      range: Range;
      text: string;
      highlightRange: Range;
      documentVersion: number;
      isDirty: boolean;
    } | null;
  }>;
};
```

References sort deterministically by URI and range. Context is optional and is dropped
before reference locations when the output budget is reached. Each context snippet is
capped at 4 KiB UTF-8.

### `get_document_symbols`

Returns a preorder flat list that preserves a hierarchical provider result without
deeply nested JSON.

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  expectedDocumentVersion?: number;
  limit?: number; // Default 500, maximum 2,000.
};

type Result = {
  document: DocumentSnapshot;
  providerShape: 'hierarchical' | 'flat';
  symbols: Array<{
    id: string; // Local to this response.
    parentId: string | null;
    name: string;
    detail: string | null;
    kind: string;
    range: Range;
    selectionRange: Range;
    deprecated: boolean;
    containerName: string | null;
  }>;
};
```

### `search_workspace_symbols`

```ts
type Input = {
  instanceId?: string;
  query: string; // Trimmed; 1 to 256 Unicode characters.
  limit?: number; // Default 100, maximum 500.
};

type Result = {
  query: string;
  symbols: Array<{
    name: string;
    kind: string;
    containerName: string | null;
    uri: string;
    range: Range;
  }>;
};
```

Provider ordering is preserved because it may encode relevance. Empty queries are
rejected and external results are filtered.

### `get_signature_help`

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  position: Position;
  expectedDocumentVersion?: number;
  triggerCharacter?: string; // Exactly one Unicode scalar value.
};

type Result = {
  document: DocumentSnapshot;
  activeSignature: number | null;
  activeParameter: number | null;
  signatures: Array<{
    label: string;
    documentation: {
      kind: 'markdown' | 'plaintext';
      value: string;
    } | null;
    parameters: Array<{
      label: string | null;
      labelRange: [number, number] | null; // UTF-16 offsets in label.
      documentation: {
        kind: 'markdown' | 'plaintext';
        value: string;
      } | null;
    }>;
  }>;
};
```

Caps: 20 signatures, 100 parameters per signature, and 64 KiB combined text.

### `get_call_hierarchy`

Version 0.1 returns one hierarchy level per call.

```ts
type Input = {
  instanceId?: string;
  document: DocumentRef;
  position: Position;
  expectedDocumentVersion?: number;
  rootIndex?: number; // Default 0.
  direction?: 'incoming' | 'outgoing' | 'both'; // Default both.
  limitPerDirection?: number; // Default 100, maximum 250.
};

type CallItem = {
  name: string;
  detail: string | null;
  kind: string;
  uri: string;
  range: Range;
  selectionRange: Range;
};

type Result = {
  document: DocumentSnapshot;
  roots: CallItem[]; // Maximum 10.
  selectedRootIndex: number;
  incoming: Array<{
    from: CallItem;
    callSiteRanges: Range[];
  }> | null;
  outgoing: Array<{
    to: CallItem;
    callSiteRanges: Range[];
  }> | null;
};
```

External roots and calls are omitted. A client may repeat the call with another prepared
`rootIndex`. Each direction contains at most 1,000 call-site ranges in total and 250 for
one returned call.

## Errors

Input-schema failures use MCP invalid-params semantics. Runtime failures set
`isError: true` and return this structured payload as JSON and text fallback:

```ts
type Failure = {
  contractVersion: '0.1.0';
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, string | number | boolean | null>;
  };
};
```

`details` contains at most 16 entries, uses keys of at most 64 characters, and is capped
at 16 KiB serialized UTF-8. It never contains source content, paths, tokens, endpoints,
or nested values.

Stable v0.1 error codes:

- `INVALID_ARGUMENT`
- `INSTANCE_NOT_FOUND`
- `INSTANCE_AMBIGUOUS`
- `INSTANCE_DISCONNECTED`
- `SERVER_BUSY`
- `WORKSPACE_UNTRUSTED`
- `WORKSPACE_FOLDER_NOT_FOUND`
- `DOCUMENT_NOT_FOUND`
- `DOCUMENT_OUTSIDE_WORKSPACE`
- `UNSUPPORTED_URI_SCHEME`
- `UNSUPPORTED_DOCUMENT`
- `DOCUMENT_TOO_LARGE`
- `DOCUMENT_VERSION_MISMATCH`
- `DOCUMENT_CHANGED_DURING_REQUEST`
- `POSITION_OUT_OF_RANGE`
- `PROVIDER_UNAVAILABLE`
- `TIMEOUT`
- `CANCELLED`
- `INTERNAL_ERROR`

An empty provider result is normally a successful empty collection.
`PROVIDER_UNAVAILABLE` is reserved for a known missing provider.

## Operational caps

- Four active calls per connection and eight per VS Code window.
- Queue depth 16; excess work returns `SERVER_BUSY`.
- Simple metadata/document operations time out after five seconds.
- Language-provider operations time out after fifteen seconds.
- Serialized MCP success payloads are capped at 512 KiB UTF-8.
- Optional snippets are dropped first, then tail results, while preserving valid
  structured output and explicit truncation warnings.
- The bridge measures the final success payload once after assembling MCP structured and
  fallback text content; the same JSON value is not duplicated in both forms.
- MCP cancellation propagates over IPC and into VS Code where the provider API supports
  a cancellation token. Late results are otherwise discarded.

No v0.1 tool saves, writes, formats, applies code actions, invokes arbitrary commands,
opens terminals, runs tasks, changes selections, reveals editors, or controls debugging.
