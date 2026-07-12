# Agent usage guide

- Status: 1.0
- Audience: MCP clients and coding-agent authors
- Scope: trusted local VS Code Desktop on macOS and Linux

`vscode-mcp` is most useful when the agent treats VS Code as the source of live IDE
truth instead of rebuilding editor state with shell commands. All positions are
zero-based UTF-16. Preserve every returned document version and pass it back to writes.

## Connect and orient

1. Call `list_instances`. If more than one window is available, keep the selected
   `instanceId` explicit for the rest of the workflow.
2. Call `get_capability_status`. Read must be true. Write and execution are
   intentionally false until the user enables their separate VS Code session commands.
3. Call `get_editor_context` for dirty buffers, active selections, visible ranges, and
   currently relevant tabs.
4. Call `list_workspace_files` for repository structure. Use its cursor instead of
   increasing limits or falling back to `find`.
5. Use one `read_documents` call for the small set of files needed for the current
   decision. Continue an individual large file with `nextStartLine`.

Do not ingest the whole repository. A good orientation batch is the repository rules,
package manifest, relevant entry point, and one or two nearby tests.

## Search and understand code

- Use `search_workspace_text` for exact identifiers, configuration keys, error strings,
  or imports across the repository. It sees unsaved buffers before disk and returns
  structured ranges. Use pagination for broad terms.
- Use `search_workspace_symbols` when looking for a declaration by semantic name.
- Use `get_document_symbols` to outline one file before reading unrelated regions.
- Use `get_definition`, `find_references`, call/type hierarchy, hover, signature help,
  highlights, and selection ranges to follow code without parsing terminal output.
- Use `get_diagnostics` before and after a change. Diagnostics and configured task
  problem matchers are the portable build/test feedback channel; generic task stdout is
  not available through the stable VS Code Task API.
- Use completion, inlay-hint, folding, and link tools when their provider data reduces
  ambiguity. Empty provider results are normal and should not trigger shell scraping.

An already authorized host filesystem search can still be faster for enormous,
persisted-only datasets. Prefer MCP when dirty-buffer correctness, VS Code exclusions,
workspace authority, or exact UTF-16 ranges matter.

## Edit safely

Ask the user to run **VS Code MCP: Enable Writes for This Session**. Then:

1. Call `list_instances` again and use the current instance ID. A pending workspace
   lifecycle refresh may have rotated the listener while the visible grant command was
   serialized.
2. Read every target and retain `documentVersion`.
3. Build sorted, non-overlapping half-open edits.
4. Submit all logically atomic text changes in one `apply_text_edits` call. If any
   document is stale, nothing is applied; reread and recompute instead of blindly
   retrying old coordinates.
5. Read the affected documents again and inspect diagnostics.
6. Inspect each returned `isDirty` state. VS Code keeps visible edited resources as
   ordinary dirty buffers but may persist non-visible resources as part of
   `workspace.applyEdit`; call `save_documents` for remaining dirty buffers and do not
   treat `revert_documents` as a history/undo mechanism.

The user can review successful mutations directly in VS Code through inline
added/modified/deleted highlights, overview-ruler marks, Explorer badges, and the
clickable **MCP: _n_ changed** status item. The next/previous commands navigate exact
post-edit ranges; clicking the status item opens a side-by-side diff or a multi-file
changes editor for the listener session. Agents should still reread versions and
diagnostics; visual attribution is local review UX, not proof that later user edits
preserved the same content.

Use `create_workspace_file` only for a missing file under an existing parent. It never
overwrites or creates parent directories. Move and delete accept regular non-symlink
files only; directories and recursive deletion are unavailable.

For semantic refactors, prefer `rename_symbol`. The extension extracts and validates
provider text entries, rejects opaque resource edits, and never executes provider
commands. `get_code_actions` returns safe edit previews and short-lived single-use apply
tokens only while write access is enabled. Re-query an expired or revoked preview.

## Build, test, run, and debug

Ask the user to run **VS Code MCP: Enable Task and Debug Execution for This Session**.
Refresh `list_instances` afterward for the same listener-rotation reason as write
enablement.

- `list_tasks` returns opaque IDs and safe metadata for configured VS Code tasks. Its
  allowlisted `runner` distinguishes package-script runtimes such as Bun or pnpm even
  when VS Code reports `source: npm`; `runner: null` means the execution is not safely
  classifiable. It deliberately omits commands, arguments, environment variables, and
  absolute paths.
- Pass an ID from the latest list to `run_task`, then poll `get_task_execution` until it
  ends. Inspect returned workspace diagnostics. `terminate_task` affects only a task
  started by this listener generation.
- `get_debug_state` lists safe metadata for named launch configurations, non-startable
  compound metadata, and tracked sessions. Pass an exact `startable: true` name and
  folder to `start_debugging`; use `noDebug` for ordinary run configurations.
  `stop_debugging` only stops a correlated tracked session.
- There is no debug-console evaluation, arbitrary DAP request, terminal input, or shell
  escape hatch. Add a reviewable VS Code task or launch configuration to the repository
  when a repeatable workflow is missing.

Revoking execution terminates tracked work where VS Code provides a stable handle.
Reload, trust loss, workspace identity change, or disabling MCP destroys all privileged
authority and listener-scoped IDs.

## Failure handling

- `DOCUMENT_VERSION_MISMATCH` / `DOCUMENT_CHANGED_DURING_REQUEST`: reread and recompute.
- `WRITE_NOT_ENABLED` / `EXECUTION_NOT_ENABLED`: ask the user to enable the matching
  visible session grant; never loop.
- `WRITE_GRANT_CHANGED` / `EXECUTION_GRANT_CHANGED`: stop and re-orient because
  authority changed mid-flight.
- `INSTANCE_NOT_FOUND` / `INSTANCE_DISCONNECTED`: if the error contains a
  `replacementInstanceId`, use it only to rediscover/reselect the same workspace and
  re-check capability status; write and execution grants do not carry across listener
  restarts. Otherwise call `list_instances` again. A reload, workspace change, or
  disable may have rotated the instance ID.
- `RESULTS_TRUNCATED`: consume the tool's cursor or narrow the query. Never infer that
  omitted data does not exist.
- `OPAQUE_PROVIDER_EDIT`: use direct version-checked text edits or split file movement
  from the semantic rename.

## Compact reference workflow

```text
list_instances
  -> get_capability_status
  -> get_editor_context
  -> list_workspace_files
  -> search_workspace_text / semantic language tools
  -> read_documents
  -> enable write grant (user action)
  -> apply_text_edits / rename_symbol
  -> get_diagnostics
  -> save_documents
  -> enable execution grant (user action, if needed)
  -> list_tasks -> run_task -> get_task_execution
```
