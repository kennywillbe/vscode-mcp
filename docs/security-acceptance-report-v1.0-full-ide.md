# Full IDE security acceptance evidence for 1.0

- Review date: 2026-07-11
- Contract: `vscode-mcp.tools/1.0.0`
- Scope: 39 MCP tools / 38 extension capabilities on local macOS and Linux Desktop
- Result: accepted for the local 1.0 candidate; publication remains a separate
  maintainer-controlled stage

This report is the full-surface addendum to the inherited transport/read acceptance
report. Evidence names below are repeatable repository commands or test files. Windows
is outside the 1.0 matrix and is covered by `docs/windows-support-plan.md`.

## Executed gates

- `pnpm check`: format, ESLint, all package typechecks, 46 files / 433 unit and
  acceptance tests.
- `pnpm test:extension`: 13 real Extension Host workflows through MCP stdio,
  authenticated IPC, the production router, and live VS Code APIs.
- `pnpm research:scanner`: 16 bounded scanner scenarios.
- `pnpm research:write`: 6 atomicity, cancellation, and commit-race scenarios.
- `pnpm audit --audit-level=high`: no known vulnerability.
- `pnpm package:release` twice: byte-identical `SHA256SUMS` and deterministic artifact
  contents.
- `pnpm test:artifacts`: freshly installed exact VSIX/server pair on supported host
  validation recorded in the platform section below.

## Full-surface criteria mapping

| Criterion  | Result | Repeatable evidence                                                                                                                                                                                                                                                        |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-GRT-001 | Pass   | `capability-grant-controller.unit.test.ts` and the write/task/debug Extension Host workflows prove both grants default off, visible status, stable denial, and no side effect.                                                                                             |
| F1-GRT-002 | Pass   | Grant-generation unit tests, revoked preview workflow, task/debug revoke workflows, and `single-use-handle-store.unit.test.ts` prove old generations and handles fail closed.                                                                                              |
| F1-GRT-003 | Pass   | Extension lifecycle disposal, stale-provider host workflow, request-scheduler waves, and task/debug revoke workflows prove queued work is withdrawn and tracked work is terminated without rollback claims.                                                                |
| F1-EDT-001 | Pass   | Protocol exact/plus-one document/edit ceilings and the successful two-document Extension Host commit prove bounded text-only multi-document application and observed versions/dirty states.                                                                                |
| F1-EDT-002 | Pass   | Schema limits, write host workflow, workspace-authorizer tests, and symlink-parent regression cover malformed, overlapping, stale, external, symlinked, and over-limit plans before commit.                                                                                |
| F1-EDT-003 | Pass   | `write-apply-spike` covers cancellation and version races on both sides of the commit boundary; the host stale sibling test proves no partial pre-commit application.                                                                                                      |
| F1-FIL-001 | Pass   | Host create workflow verifies exact UTF-8 bytes, existing parent requirement, user-only creation mode, and non-overwrite.                                                                                                                                                  |
| F1-FIL-002 | Pass   | Host overwrite, missing parent, symlink parent, external canary, directory, and schema regressions return stable errors without external change.                                                                                                                           |
| F1-FIL-003 | Pass   | Host move/delete workflow and source checks prove regular-file-only same-root operations, `COPYFILE_EXCL`, rollback-on-unlink-failure path, and no recursive surface.                                                                                                      |
| F1-PRV-001 | Pass   | Host semantic rename, format, save, and edit-only code-action workflows apply provider text edits through the common final generation/version check.                                                                                                                       |
| F1-PRV-002 | Pass   | Opaque resource-operation and command-bearing host providers receive no token; source-size/entries validation, external filtering, edit bounds, cycle projection, and static arbitrary-command rejection cover opaque results.                                             |
| F1-PRV-003 | Pass   | Single-use handle unit tests cover expiry, tamper/missing token, generation, workspace, cap, clear, and store isolation; host tests cover valid use, reuse, and revoke.                                                                                                    |
| F1-LSP-001 | Pass   | 39-tool host inventory invokes all eight additive families; real external-location and malicious oversized-completion workflows plus provider-bound unit tests prove authorization, deterministic bounded projection, URI stripping, and explicit truncation.              |
| F1-TSK-001 | Pass   | Task host workflow uses real `fetchTasks`, verifies safe metadata only, and static surface tests forbid command/args/env/path disclosure; implementation and contract cap discovery at 200 with explicit omission metadata.                                                |
| F1-TSK-002 | Pass   | Task host workflow rediscovers the opaque ID, starts the exact configured task, reports exit/diagnostics, tracks it, and terminates only its execution ID.                                                                                                                 |
| F1-TSK-003 | Pass   | Host forged and post-list ambiguous ID regressions plus source cap enforcement prove no alternate task selection or fifth active start.                                                                                                                                    |
| F1-TSK-004 | Pass   | Host finish/hang/revoke paths, 30-minute timer ownership, end-event terminal-state regression, scheduler disconnect/cancel waves, and disposal prove one-way terminal state and slot release.                                                                              |
| F1-DBG-001 | Pass   | Host discovery, exact configured-name check, unknown-name rejection, workspace/name session correlation, no-debug start, tracked stop, and revoke cover the stable launch boundary. Compounds are explicitly non-startable because no aggregate stable stop handle exists. |
| F1-DBG-002 | Pass   | Strict schemas reject config/DAP bodies; unknown name and stale stop ID fail; correlation rejects foreign workspace/name sessions; static tests prove no evaluation or custom request path.                                                                                |
| F1-OUT-001 | Pass   | New provider projection uses 192 KiB, previews 128 KiB, diagnostics 200 bounded items, and other mutation/execution results are metadata-only. The malicious provider host response is asserted below 448 KiB; inherited framing enforces 512 KiB.                         |
| F1-LOG-001 | Pass   | Runtime security instrumentation places canaries in content, tokens, provider failures, paths, and request outcomes; stderr, MCP errors, registry, and isolated persistent state contain none.                                                                             |
| F1-CMP-001 | Pass   | The 39-tool inventory and `security-surface.static.test.ts` prove no generic shell, terminal input, Git, arbitrary command, DAP custom request, HTTP listener, telemetry, overwrite, or recursive deletion surface.                                                        |
| F1-E2E-001 | Pass   | Exact-pair clean-cache Extension Host runs install the VSIX and separately extracted server and exercise explore, edit, create, rename, format/save, task, and debug workflows without shell/filesystem fallback for ordinary agent work.                                  |

## Platform and artifact disposition

The exact current pair is tested on macOS arm64 and in a clean Linux container using
Node.js 22.13.0, pnpm 10.24.0 verified against the official release asset SHA-256, and
VS Code stable under Xvfb. The pinned CI matrix repeats source and installed-pair tests
on `ubuntu-latest` and `macos-latest` at both VS Code `1.101.0` and stable after the
repository is created. A local macOS minimum-version run provides the pre-publication
lower-bound check; hosted CI is not falsely claimed before a GitHub repository exists.

Release-verifier negative tests reproduce and reject trailing/leading archive-name
aliases, local-versus-central ZIP name disagreement, comment-masked VSIX identity,
version drift, disconnected CycloneDX components, missing/extra checksums, unsafe paths,
and noncanonical manifests. Artifact tests delete their VS Code caches before and after
each run.

The local exact-pair harness uses a unique owner-only short runtime directory for every
run. This prevents a concurrently enabled real VS Code window from entering artifact
discovery while keeping Unix socket paths below the macOS limit.

Final local payload digests are
`e80ac028cf9d50a64dacf24b8a7f77d0b28a0be5fa0532239de93a740575697f` for
`vscode-mcp-extension-1.0.0.vsix` and
`1b27b1ca6644e89aa2ce9ff746db2de45d9b97fe644ee0ff7136c7cfb2f36720` for
`vscode-mcp-server-1.0.0.tar.gz`; the complete signed input list is the local
`artifacts/release-1.0.0/SHA256SUMS` file.

## Residual boundaries

- Same-user hostile filesystem mutation between canonical checks and the final POSIX
  filesystem syscall is a documented local race boundary; no remote or lower-privilege
  actor is admitted, and results never claim rollback after commit.
- Generic task stdout is unavailable through the stable Task API; diagnostics and exit
  state are the portable output channel.
- Compound debug configurations are visible but non-startable because the stable API
  cannot return one safely scoped handle for all child sessions.
- GitHub-hosted evidence, repository rules, public visibility, private vulnerability
  reporting, signed tag, public-install verification, and exact-VSIX Marketplace upload
  belong to the publication stage and retain their documented approval gates.
