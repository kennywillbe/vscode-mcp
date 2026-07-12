# ADR 0004: Agent tools and write authorization

- Status: Accepted
- Date: 2026-07-11
- Accepted: 2026-07-11
- Scope: Full 1.0 workspace mutation and inspectable provider edits

## Context

The maintainer requires the first complete product—not a reduced MVP—to let coding
agents inspect and deliberately modify an enabled workspace without falling back to
shell text-processing for ordinary repository work. Workspace Trust and read enablement
authorize inspection but do not authorize mutation. MCP annotations and client-side
approval UI are descriptive and cannot replace extension-owned enforcement.

Stable VS Code exposes structured text and resource edits through `WorkspaceEdit`,
supports text-only multi-document application through `workspace.applyEdit`, and exposes
provider rename/code-action results. `WorkspaceEdit.entries()` makes text edits
inspectable, while provider commands and opaque resource operations are not sufficiently
inspectable for automatic application.

## Decision

### Session write grant

- Writes remain off by default even when read access is enabled.
- The VS Code extension owns a visible, window-session-scoped write grant. It is never
  persisted across extension-host restarts.
- Explicit VS Code commands enable and revoke the grant. The status bar always exposes
  read/write/execution state and offers the corresponding controls.
- Tools remain discoverable while disabled and return `WRITE_NOT_ENABLED`; authorization
  never depends on a client refreshing its tool list.
- Revocation, trust loss, read disablement, workspace identity change, or listener stop
  invalidates queued/preparing writes and all preview tokens.
- A session grant avoids one modal per edit while preserving a deliberate, visible user
  action. MCP elicitation may provide extra client UX later but is not an authority.

### Direct workspace mutations

The accepted write inventory includes:

- bounded expected-version `apply_text_edits` for one or more existing documents;
- non-overwriting `create_workspace_file` with explicit text content and no implicit
  parent creation;
- non-overwriting file move/rename within one authorized workspace authority;
- explicit file deletion for regular authorized files only, never recursive directory
  deletion;
- explicit document save and revert operations; and
- formatting through inspectable provider text edits.

All paths are workspace-relative, canonicalized, deepest-root authorized, and rechecked
immediately before commit. Symlink paths, unsupported schemes, directories, overlapping
edits, stale versions, oversized inputs, ambiguous roots, overwrite requests, and mixed
authority fail before mutation.

### Commit and cancellation semantics

- Complete every asynchronous preparation step first.
- Immediately before commit, synchronously recheck write grant generation, read
  eligibility, workspace fingerprint, cancellation, canonical authority, and every live
  document version.
- Do not yield between the final state check and `workspace.applyEdit`.
- Invocation is the commit boundary. Cancellation or revocation after it begins cannot
  promise rollback; the response reports the observed committed outcome honestly.
- Text-only multi-document edits use one `WorkspaceEdit`. File create/move/delete and
  save/revert are separate operations and never claim cross-operation atomicity.

### Rename symbol and code actions

- `rename_symbol` invokes the stable rename-provider command, treats the returned
  `WorkspaceEdit` as untrusted, and applies it only when every operation is an
  inspectable text edit.
- Provider edits are canonicalized, deepest-root authorized, range/version checked,
  sorted, bounded, and revalidated under the same no-yield commit rule.
- If `WorkspaceEdit.size` cannot be accounted for by `entries()`, the provider result
  contains opaque resource operations and is rejected.
- Code actions use a preview/list step and an opaque single-use token. Only actions with
  a fully inspectable edit and no command are eligible. Command-bearing or unresolved
  actions are returned as unavailable and never executed.
- Formatting provider results are plain text edits and follow the same validation path.

### Limits and errors

Canonical limits and stable errors live in the full 1.0 contract and protocol package.
They independently bound documents, edits, replacement bytes, created content, provider
items, preview tokens, response bytes, queues, concurrency, and deadlines. Errors never
contain source text, replacement content, absolute paths, provider command arguments, or
other sibling details.

## Security consequences

- A compromised MCP client with a granted write session can modify the enabled
  workspace; the visible grant is a high-impact authority and must be easy to revoke.
- The bridge remains untrusted for scope enforcement.
- Provider output cannot escape the workspace or smuggle command execution.
- Direct arbitrary filesystem writes, recursive deletion, overwrite, generic command
  execution, and automatic saving after edits remain prohibited.
- Execution of workspace code is a separate authority governed by ADR 0007.

## Rejected shortcuts

- Treating Workspace Trust or read enablement as implicit write consent.
- Persisting write grants across sessions.
- Trusting the MCP client or bridge to filter paths or provider output.
- Applying command-bearing code actions or opaque provider resource edits.
- Generic write-file, patch, shell, or arbitrary `executeCommand` escape hatches.
- Claiming rollback after a commit has begun.
