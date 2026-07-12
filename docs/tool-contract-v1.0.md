# MCP tool contract 1.0

- Status: Accepted — complete-product contract implemented and locally validated
- Contract ID: `vscode-mcp.tools/1.0.0`
- Product release: `1.0.0`
- Scope: Trusted local VS Code Desktop workspaces on macOS and Linux

This contract supersedes the plan to ship a read-only first release. It inherits the
eleven v0.1 tools unchanged and the three accepted v0.2 read tools, then adds the
structured language, mutation, task, run, and debug capabilities required for a complete
agent-oriented IDE surface. It does not add a generic shell, terminal, Git, arbitrary VS
Code command, or arbitrary DAP channel.

## Inventory

### Existing and agent-ready reads

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
12. `list_workspace_files`
13. `read_documents`
14. `search_workspace_text`
15. `get_capability_status`

### Additional structured IDE intelligence

16. `get_completions`
17. `get_code_actions`
18. `get_document_highlights`
19. `get_type_hierarchy`
20. `get_inlay_hints`
21. `get_folding_ranges`
22. `get_selection_ranges`
23. `get_document_links`

### Mutations

24. `apply_text_edits`
25. `create_workspace_file`
26. `move_workspace_file`
27. `delete_workspace_file`
28. `save_documents`
29. `revert_documents`
30. `rename_symbol`
31. `format_document`
32. `apply_code_action`

### Configured execution and debug

33. `list_tasks`
34. `run_task`
35. `get_task_execution`
36. `terminate_task`
37. `get_debug_state`
38. `start_debugging`
39. `stop_debugging`

## Capability states

`get_capability_status` returns the selected instance's current read, write, and
execution state plus non-secret listener generation identifiers suitable only for
detecting state change. It never returns grant tokens, registry paths, endpoints, or
absolute paths.

Read access uses the existing trusted/explicitly-enabled workspace lifecycle. Write and
execution are independent extension-owned session grants. Disabled calls return
`WRITE_NOT_ENABLED` or `EXECUTION_NOT_ENABLED`. Losing read eligibility invalidates both
high-impact grants. Grant generation changes invalidate queued work and preview/task
handles.

## Language intelligence

Every language tool selects one authorized document snapshot and uses a fixed stable VS
Code provider command. Inputs never contain a command identifier. Results:

- preserve zero-based UTF-16 positions and half-open ranges;
- bind to the observed document version;
- filter external or unsupported locations;
- omit provider commands and unsafe Markdown/HTML according to inherited rules;
- use deterministic ordering and deduplication;
- expose explicit truncation and bounded warning counts; and
- recheck the document version after asynchronous provider work.

`get_document_symbols` reports both the provider shape and
`providerReportedNestedSymbols`. The latter is true only when the provider returned at
least one explicit parent/child relationship; false means callers may need targeted
reads or searches because the extension does not invent members that the provider
omitted.

`search_workspace_text` treats its query as exact literal text, including leading and
trailing whitespace. `contextLines` is restricted to 0–2 in both runtime validation and
the advertised MCP JSON Schema.

Completions return labels, kinds, sort/filter text, bounded documentation, replacement
ranges, and insert text but never execute completion commands. Code actions return
bounded previews. Only fully inspectable text-edit-only actions receive an opaque,
single-use apply token. Type hierarchy, highlights, hints, folds, selections, and links
remain read-only and workspace-authorized.

## Direct text edits

`apply_text_edits` accepts 1–32 document groups and at most 2,048 total edits. Every
group contains an authorized document reference, required expected version, and sorted,
non-overlapping replacements. One replacement is at most 256 KiB UTF-8 and aggregate
replacement text is at most 2 MiB. All asynchronous preparation completes before a final
no-yield grant/workspace/version/cancellation check and one text-only
`workspace.applyEdit` commit.

The result reports affected compact document identities, versions observed before and
after, edit counts, and whether buffers are dirty. It never echoes replacement or source
text. Failure before commit guarantees no edit was applied. Cancellation after commit
does not claim rollback.

Before commit, target documents are opened as editor tabs so visible resources retain
ordinary dirty-buffer behavior. VS Code may still persist non-visible resources during a
multi-resource `workspace.applyEdit`; callers must use each returned `isDirty` value
instead of assuming either saved or unsaved state. `revert_documents` restores the
current saved bytes of dirty documents and is not an undo/history service.

Successful content mutations also produce extension-local visual attribution. The
extension derives exact post-edit UTF-16 ranges from the validated edit plan and renders
added, modified, and deletion markers without adding fields to MCP results. Visual
records are bounded to 200 files / 4,096 markers, contain no source or replacement text,
while optional before-snapshots are capped at 2 MiB each / 32 MiB total. Both metadata
and snapshots remain memory-only for the listener generation, never cross MCP, and never
affect commit success. A subsequent non-MCP edit clears the affected file's attribution
rather than retaining a stale range.

## File operations

- `create_workspace_file` creates one regular UTF-8 file up to 2 MiB at an authorized
  relative path. Destination and every parent must already exist canonically inside the
  selected root; overwrite and implicit parent creation are forbidden.
- `move_workspace_file` moves one existing regular non-symlink file to one absent
  destination in the same deepest-root authority. Directory moves and overwrite are
  forbidden.
- `delete_workspace_file` deletes one existing regular non-symlink file. Recursive or
  directory deletion is forbidden.
- Each resource operation is a separate commit and is never combined with text-edit
  atomicity claims.
- `save_documents` and `revert_documents` accept at most 32 exact authorized open
  documents with expected versions. Revert is classified destructive.

## Provider-backed writes

`rename_symbol`, `format_document`, and `apply_code_action` convert provider-returned
text entries into the same validated, newly constructed text-only plan used by
`apply_text_edits`. Commands are never executed. `WorkspaceEdit.size` must equal the
number of text-entry resources returned by `entries()`; a mismatch rejects the result as
opaque. The original provider `WorkspaceEdit` is never applied: only copied, authorized
text entries are committed. File-renaming refactors that require a provider resource
operation are therefore rejected rather than partially applied. External documents,
symlinks, overlapping ranges, unsupported schemes, more than 32 documents, more than
2,048 edits, or more than 2 MiB replacement text are rejected.

Code-action preview tokens:

- are cryptographically random, listener-generation scoped, single-use, and expire after
  60 seconds;
- bind action identity, document version, workspace fingerprint, grant generation, and a
  hash of the fully validated edit plan; and
- are destroyed on use, revocation, trust/read loss, workspace change, or listener stop.

## Tasks, build, test, run, and debug

`list_tasks` exposes at most 200 tasks from `tasks.fetchTasks`, restricted to the
selected workspace/folder. Safe metadata includes opaque listener-scoped task ID, name,
source, an allowlisted `runner` (`npm`, `yarn`, `pnpm`, `bun`, `node`, or `vp`) when the
VS Code task exposes an inspectable process or structured shell command, group,
background flag, and problem-matcher count. Unknown, custom, or full-command-line
executions report `runner: null`. It never returns shell/process commands, arguments,
environment variables, or absolute paths.

`run_task` executes only one currently rediscovered task matching an opaque ID and an
active execution grant. At most four MCP-started task executions may be tracked per
window. Calls return promptly with an execution ID; `get_task_execution` reports bounded
state, exit code when available, timestamps, and diagnostics observed for the selected
workspace. `terminate_task` affects only an execution started by the same listener.
Tracked tasks are automatically terminated after 30 minutes or on grant/lifecycle loss.

`start_debugging` accepts one folder, a 1–256 character exact named launch
configuration, and `noDebug`. It never accepts a configuration object. Compound names
are discoverable with `startable: false`: the stable API does not provide a safe handle
for the complete child-session set, so the MCP cannot promise scoped stop/revoke for a
compound. At most four MCP-started sessions are tracked. `get_debug_state` exposes
bounded names/types, startability, and lifecycle state without DAP bodies.
`stop_debugging` stops only a correlated tracked session. Execution revocation stops
tracked task/debug work where the stable API provides a handle. Debug-console evaluation
and `customRequest` are unavailable.

## Shared hard limits

| Resource                           |                   Limit |
| ---------------------------------- | ----------------------: |
| MCP input                          |                 256 KiB |
| MCP result                         |                 512 KiB |
| New structured success target      |                 448 KiB |
| Provider deadline                  |                    15 s |
| Simple mutation preparation        |                     5 s |
| Documents per write                |                      32 |
| Text edits total / per document    |             2,048 / 512 |
| Replacement bytes total / per edit |         2 MiB / 256 KiB |
| Created file content               |                   2 MiB |
| Code actions / completions         |               100 / 200 |
| Preview handles                    | 32, expiring after 60 s |
| Tasks listed / tracked             |                 200 / 4 |
| Debug sessions tracked             |                       4 |
| Task maximum lifetime              |                  30 min |

Existing v0.1/v0.2 read ceilings remain unchanged.

## Stable errors

The full contract inherits existing errors and adds:

- `WRITE_NOT_ENABLED`
- `EXECUTION_NOT_ENABLED`
- `WRITE_GRANT_CHANGED`
- `EXECUTION_GRANT_CHANGED`
- `EDIT_CONFLICT`
- `EDIT_LIMIT_REACHED`
- `PREVIEW_REQUIRED`
- `PREVIEW_EXPIRED`
- `PREVIEW_ALREADY_USED`
- `OPAQUE_PROVIDER_EDIT`
- `FILE_ALREADY_EXISTS`
- `PARENT_NOT_FOUND`
- `DIRECTORY_OPERATION_UNSUPPORTED`
- `TASK_NOT_FOUND`
- `TASK_AMBIGUOUS`
- `TASK_LIMIT_REACHED`
- `EXECUTION_NOT_FOUND`
- `DEBUG_CONFIGURATION_NOT_FOUND`
- `DEBUG_SESSION_NOT_FOUND`

Messages are stable, bounded, and contain no source/replacement text, provider command
arguments, task commands, environment variables, absolute paths, or secret handles.

## Annotations

Read/intelligence/status/list tools are read-only and non-destructive. Text edits,
create, move, save, rename, format, and edit-only code actions are non-read-only but
non-destructive. Delete and revert are destructive. Task/run/debug starts are
non-read-only, potentially destructive, and closed-world; termination tools are
non-read-only controls. Annotations never replace extension enforcement.
