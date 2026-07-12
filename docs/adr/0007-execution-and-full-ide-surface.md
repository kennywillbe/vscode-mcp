# ADR 0007: Execution grant and full IDE surface

- Status: Accepted
- Date: 2026-07-11
- Accepted: 2026-07-11
- Scope: Agent-oriented language intelligence, tasks, run, and debug controls for 1.0

## Context

The maintainer requires agents to use VS Code as an IDE rather than merely a read-only
language-provider proxy. Agents need broad structured language intelligence, repository
discovery/search, inspectable edits, configured build/test tasks, and named run/debug
configurations without using ad-hoc shell parsing for ordinary work.

Executing workspace tasks or debug configurations runs workspace-controlled code and is
more powerful than mutation. It therefore cannot inherit read or write authority. Stable
VS Code APIs enumerate tasks, start/terminate task executions, report process
completion, start named debug configurations (including no-debug mode), expose debug
session lifecycle, and stop sessions. The task API does not expose a reliable generic
stdout capture channel; problem matchers surface build/test findings through
diagnostics.

## Decision

### Full language-intelligence surface

The 1.0 contract adds bounded tools for completions, code actions, document highlights,
type hierarchy, inlay hints, folding ranges, selection ranges, document links, rename,
and formatting. Existing diagnostics, hover, definitions, references, symbols, signature
help, and call hierarchy remain. Every provider result is untrusted, authorized,
version-checked, normalized, deterministically ordered, and bounded.

No tool accepts an arbitrary VS Code command identifier. Programmatic provider commands
are fixed in extension code and selected by a closed enum.

### Session execution grant

- Execution is off by default and separate from the read and write grants.
- Explicit VS Code commands enable/revoke it for the current extension-host session.
- The status bar makes execution state visible.
- Trust loss, read disablement, workspace identity change, listener stop, or revocation
  prevents queued starts and terminates executions started through MCP where VS Code
  provides a termination handle.
- Execution tools remain listed while disabled and return `EXECUTION_NOT_ENABLED`.

### Tasks/build/test

- `list_tasks` exposes bounded safe metadata for tasks returned by `tasks.fetchTasks`.
- `run_task` selects exactly one previously discovered task by an opaque listener-scoped
  ID and requires the execution grant.
- Only tasks scoped to the selected workspace or workspace folder are eligible; global,
  ambiguous, or unscoped tasks are omitted.
- The tool may wait for bounded process completion or return a tracked execution ID.
  `terminate_task` can stop only executions started by this MCP listener generation.
- Results include lifecycle/exit status and a bounded diagnostics delta. They do not
  claim to capture terminal stdout when the stable task API does not provide it.
- The extension never constructs a new shell/process task from MCP arguments.

### Run/debug

- `start_debugging` accepts a selected workspace folder and bounded named configuration,
  plus an explicit `noDebug` boolean. Arbitrary configuration objects are rejected.
- Starting debug may save files according to VS Code behavior; this side effect is
  documented and requires the execution grant.
- `get_debug_state` returns bounded session identity/state without DAP payloads.
- `stop_debugging` stops only sessions started and tracked by this MCP listener
  generation unless the user acts directly in VS Code.
- Arbitrary DAP `customRequest`, debug-console evaluation, breakpoint mutation, terminal
  input, and debugger memory access are not exposed.

### Direct shell and terminal

The full product does not add a generic shell or terminal-input tool. Configured tasks
and named debug/run configurations cover IDE-native build, test, run, and debug entry
points while keeping the execution surface reviewable and user-owned. This is a
deliberate security boundary, not an MVP deferral.

## Consequences

- Agents can build, test, run, and debug projects configured in VS Code and consume
  resulting diagnostics without inventing shell commands.
- Users retain one visible high-impact execution switch.
- stdout/stderr fidelity depends on stable VS Code task/debug APIs; the contract states
  that limitation honestly.
- Arbitrary command execution remains unavailable even though configured workspace code
  can itself perform arbitrary actions once the user grants execution.
