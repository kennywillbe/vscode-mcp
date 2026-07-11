# Full 1.0 IDE security model

- Status: Accepted
- Date: 2026-07-11
- Inherits: `security-model.md` and `security-model-v0.2-read.md`
- Governs: language expansion, mutations, configured tasks, run, and debug

## Authority model

The extension remains the sole authority. The bridge, MCP client, model, provider
extensions, workspace files, tasks, debug configurations, registry records, and every
returned edit are untrusted.

Three independent states exist per VS Code window:

| State           | Persistence                             | Prerequisites                                         | Revocation effect                                   |
| --------------- | --------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| Read enabled    | Existing canonical-workspace setting    | local Desktop, trust, eligible file roots             | listener withdrawal                                 |
| Write grant     | Memory only, one extension-host session | current read eligibility and explicit VS Code command | cancel queued/preparing writes, destroy previews    |
| Execution grant | Memory only, one extension-host session | current read eligibility and explicit VS Code command | prevent starts and terminate MCP-tracked executions |

Grant state and generation never cross IPC as a bearer token. The extension checks the
current generation before every high-impact commit/start. Status responses expose only
booleans and non-secret change identifiers.

## Mutation threats and controls

| Threat                                    | Control                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path escape, symlink swap, case confusion | Canonical deepest-root authorization, non-following descriptor checks where filesystem access is direct, and immediate pre-commit revalidation.            |
| Stale agent plan                          | Required expected versions, provider version snapshots, final synchronous recheck.                                                                         |
| Overlapping or malformed edits            | UTF-16 range validation against exact snapshots; deterministic sort; overlap rejection.                                                                    |
| Partial text mutation                     | One text-only `WorkspaceEdit`; no asynchronous yield after final checks.                                                                                   |
| Provider command smuggling                | Fixed provider command IDs in code; returned commands rejected; no arbitrary execute-command tool.                                                         |
| Opaque rename/resource operation          | Require `WorkspaceEdit.size === entries().length`, then discard the provider edit and reconstruct a text-only edit; mismatch fails `OPAQUE_PROVIDER_EDIT`. |
| Overwrite or recursive deletion           | No overwrite flags, no directory operations, explicit absent/existing checks.                                                                              |
| Secret leakage                            | No source/replacement content, absolute paths, task commands, environment, preview secrets, or payload logs.                                               |
| Replay                                    | Listener/grant/version-bound single-use previews with TTL and constant-time secret comparison.                                                             |
| Cancellation race                         | Cancellation prevents pre-commit action; post-commit response reports reality and never promises rollback.                                                 |

## Execution threats and controls

Configured tasks and debug configurations can execute arbitrary workspace-controlled
code. The user-visible execution grant is therefore equivalent to allowing the enabled
workspace's existing IDE run surface for the current session.

- MCP cannot submit a shell string, executable, arguments, environment, task definition,
  debug configuration object, terminal input, or DAP request.
- Task IDs are cryptographically random, listener-scoped handles mapped to a hash of
  bounded safe metadata, and the task is always rediscovered and matched again through
  `tasks.fetchTasks` before execution.
- Only exact selected workspace/folder tasks are eligible. Ambiguity fails closed.
- Named debug configuration starts are folder-scoped; provider resolution remains VS
  Code-owned. Starts and sessions are correlated through bounded lifecycle trackers.
- Only executions/sessions started by this listener generation receive MCP termination
  handles.
- Execution revocation and listener stop attempt termination; late events are ignored
  after tracked settlement and cannot reuse released admission slots.
- Task stdout is not captured through undocumented terminal internals. Diagnostics from
  problem matchers are the structured build/test feedback channel.

## Provider and collection bounds

Provider arrays are traversed through raw caps before normalization. Commands,
additional edits, Markdown, locations, hierarchy graphs, links, and nested collections
are treated as adversarial. Cycle/depth/item/byte limits apply before public projection.
Every returned location is reauthorized. Every mutation edit is validated independently.

## Lifecycle

Read disablement, trust loss, workspace-folder change, listener restart, extension
shutdown, write revocation, and execution revocation are authority transitions. Each
transition increments/destroys the relevant generation state before awaiting cleanup so
new work observes revocation immediately.

## Logging and persistence

Allowed logs: tool name, safe stable outcome code, duration, aggregate item/byte counts,
grant state transition name, and tracked execution count.

Forbidden logs/persistence: source and replacement text, relative/absolute filenames,
queries, task/debug names when user-authored, task definitions, commands, arguments,
environment, provider bodies, preview/task IDs, grant material, endpoints, tokens, or
full requests/responses. No content index, edit preview, or execution history persists
across the listener generation.

## Residual risk

- A client with a user-granted write session can intentionally damage authorized files.
- A client with a user-granted execution session can run malicious code already exposed
  through configured workspace tasks or named debug configurations.
- Workspace extensions and language providers execute in VS Code's extension ecosystem
  and may themselves be compromised.
- VS Code resource-edit application and task/debug APIs have commit/start races that
  cannot be rolled back by this extension.
- The stable API exposes only an affected-resource count for resource edits. The
  size/entry equality gate detects ordinary mixed/resource-only provider edits and the
  extension applies only a reconstructed text edit, but a malicious provider could
  theoretically hide a resource operation on a URI already represented by text edits;
  that hidden operation is discarded, never applied.
- Same-user local process and compromised extension-host attacks remain inherited.
