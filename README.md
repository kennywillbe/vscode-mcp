# vscode-mcp

`vscode-mcp` is a local, agent-oriented bridge from MCP clients to VS Code's live IDE
state. It exposes bounded repository discovery and dirty-buffer-aware reads, language
intelligence, version-checked edits and file operations, configured tasks, and named
run/debug configurations without adding a generic shell, terminal, Git controller, or
network service.

> [!IMPORTANT] The local macOS/Linux 1.0 candidate is implemented and validated, but it
> has not been published. Windows is deferred to a post-1.0 roadmap milestone and fails
> closed before listener or registry publication.

## How it works

```text
MCP client --stdio--> bundled bridge --authenticated local IPC--> VS Code extension
```

The extension is the authorization authority. A VS Code window is discoverable only
while all of these conditions hold:

- it is a standard local VS Code Desktop window;
- every workspace folder uses the local `file:` scheme;
- Workspace Trust is granted; and
- the user explicitly enables the canonical workspace-folder set.

The bridge authenticates each candidate window, selects an instance deterministically,
and forwards a bounded request. The extension rechecks workspace eligibility and path
authorization for every call and filters language-provider locations before returning
them. Losing trust, disabling the workspace, changing its folder identity, or stopping
the extension withdraws the listener and invalidates its credentials.

## Complete 1.0 tool surface

The frozen 1.0 contract contains 39 tools:

| Area                  | Tools                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instance and editor   | `list_instances`, `get_editor_context`, `get_capability_status`                                                                                                                |
| Repository reads      | `read_document`, `read_documents`, `list_workspace_files`, `search_workspace_text`                                                                                             |
| Language intelligence | diagnostics, hover, definitions, references, symbols, signature/call/type hierarchy, completions, code actions, highlights, inlay hints, folds, selections, and document links |
| Workspace mutation    | `apply_text_edits`, create/move/delete file, save/revert, `rename_symbol`, formatting, and text-edit-only code-action application                                              |
| Configured execution  | list/run/status/terminate configured VS Code tasks and inspect/start/stop named run/debug configurations                                                                       |

All positions use zero-based UTF-16 coordinates. Inputs, provider calls, collection
sizes, response bytes, concurrency, queues, and deadlines are bounded. Reductions are
deterministic and carry explicit truncation metadata or warnings.

The exact schemas, limits, errors, and all tool names are in the
[1.0 tool contract](./docs/tool-contract-v1.0.md). Configured VS Code tasks are the
build/test execution boundary; named launch configurations are the run/debug boundary.
The project intentionally has no arbitrary shell string, terminal input, Git control,
arbitrary `executeCommand`, debug-console evaluation, or DAP custom-request tool.

Read access is enabled per trusted canonical workspace. Write and execution authority
are separate, off by default, memory-only grants. Use **VS Code MCP: Enable Writes for
This Session** and **VS Code MCP: Enable Task and Debug Execution for This Session**;
the matching disable commands revoke them immediately. Reloading VS Code, disabling MCP,
changing workspace identity, or losing trust destroys both grants.

## Security properties

- MCP uses `stdio`; the extension opens only user-scoped local IPC.
- Every session has a cryptographically random endpoint and authentication token.
- The handshake is authenticated, versioned, constant-time compared, and fails closed.
- Registry records, IPC and MCP frames, paths, Markdown, and provider results are
  treated as untrusted input.
- Open dirty buffers win over disk content; closed paths are canonicalized and checked
  against the selected workspace before they are opened.
- Provider-returned external locations are omitted rather than disclosed.
- Direct and provider-backed edits require current document versions, canonical
  workspace authority, non-overlapping bounded changes, and a final grant/version check
  immediately before VS Code receives the edit transaction.
- Create and move never overwrite. Delete is limited to one regular non-symlink file;
  directory and recursive deletion are unavailable.
- Tasks can only be selected from `tasks.fetchTasks`; task commands, arguments, and
  environment values are never returned. Debugging accepts only a folder and a named
  exact named launch configuration. Compounds are discoverable but deliberately marked
  non-startable because VS Code does not expose a safely scoped aggregate stop handle.
- Provider-owned arrays and nested collections are copied only to fixed raw budgets
  before the narrower public limits; cap-plus-one entries are not inspected.
- A cancelled or timed-out non-cancellable provider keeps its execution slot until its
  original promise settles, preventing detached work from bypassing admission limits.
- Source text, provider bodies, tokens, endpoints, absolute paths, and full payloads are
  excluded from logs.
- There is no telemetry, analytics, updater, background daemon, HTTP/SSE listener, or
  persistent content log.

An MCP client can still send returned data elsewhere. Review that client's model,
privacy, and retention settings independently.

See the [full 1.0 security model](./docs/security-model-v1.0-full-ide.md), the inherited
[read/transport security model](./docs/security-model.md),
[internal IPC contract](./docs/internal-ipc-v1.md), and
[security acceptance evidence](./docs/security-acceptance-report-v1.0-full-ide.md) for
the exact boundary and verification evidence.

## Repository layout

- `packages/extension` owns VS Code APIs, authorization, live editor state, language
  providers, and the local IPC listener.
- `packages/server` owns MCP `stdio`, instance discovery and selection, the IPC client,
  and MCP tool registration.
- `packages/protocol` owns strict shared schemas, wire contracts, limits, credentials,
  and stable error codes without depending on VS Code or the MCP SDK.
- `fixtures` contains extension-host integration workspaces.
- `docs` contains the accepted contracts, ADRs, security reviews, and release guides.

## Development

Use Node.js 22 and pnpm 10.24.0. pnpm is the only package manager for this repository.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm audit
pnpm check
pnpm build
pnpm test:extension
```

Check the local toolchain and start the complete protocol, extension, and server watch
loop with:

```sh
pnpm doctor
pnpm dev
```

For a local unpublished install, `pnpm setup:local -- --install` builds the server,
packages and installs the VSIX, and writes a reviewable MCP configuration snippet under
`artifacts/local/`. `VSCODE_TEST_VERSION=stable pnpm test:local` tests that exact pair
in an isolated Extension Host. See the [local development guide](./docs/development.md)
for the reload workflow and command details.

Create a local, unpublished development VSIX with:

```sh
pnpm package:vsix
```

After every release gate is complete and all package versions are `1.0.0`, create the
complete local candidate with:

```sh
pnpm package:release
```

That command writes a version-matched VSIX and server archive, a CycloneDX SBOM,
licenses and third-party notices, a release manifest, and SHA-256 checksums under
`artifacts/release-1.0.0/`. It has no upload or publication path. See the
[release-candidate process](./docs/release-process.md).

Test the exact packaged VSIX and extracted server rather than source-development bundles
with:

```sh
VSCODE_TEST_VERSION=1.101.0 pnpm test:artifacts
VSCODE_TEST_VERSION=stable pnpm test:artifacts
```

## Compatibility and deferred environments

The supported 1.0 path targets standard local VS Code Desktop 1.101.0 or newer on macOS
and Linux, with Node.js 22.13.0 or newer in the Node.js 22 line for the bridge. Windows
is explicitly deferred; the extension and runtime registry reject it before publishing
local IPC.

Remote SSH, WSL, Dev Containers, Codespaces, VS Code for the Web, virtual workspaces,
Snap, and Flatpak are deferred and fail closed.

## Distribution status

No preview version, package, VSIX, or server archive has been published. The current
`artifacts/release-1.0.0/` directory is the checksummed local 1.0 candidate produced
from this working tree; it is not a public release. The repository is prepared privately
before the first public `1.0.0` GitHub Release. After that release is verified, the same
VSIX is published to the VS Code Marketplace. Open VSX, npm, JSR, Yarn, and Bun remain
out of scope.

Installation, upgrade, downgrade, and removal are documented in
[docs/installation.md](./docs/installation.md). Candidate construction and verification
are documented in [docs/release-process.md](./docs/release-process.md); publishing still
requires an explicit maintainer decision.

## Contributing and license

Read [AGENTS.md](./AGENTS.md) before changing this repository, then follow
[CONTRIBUTING.md](./CONTRIBUTING.md). The project is licensed under
[Apache-2.0](./LICENSE); third-party terms are recorded in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

This project is not affiliated with or endorsed by Microsoft. Visual Studio Code and VS
Code are trademarks of Microsoft Corporation.
