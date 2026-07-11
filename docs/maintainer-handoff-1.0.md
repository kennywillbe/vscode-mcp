# Maintainer handoff for the local 1.0 candidate

- Updated: 2026-07-11
- Candidate status: complete local product implementation; final validation evidence
  recorded below
- Publication state: private GitHub setup authorized; no public visibility, tag, upload,
  GitHub Release, Marketplace entry, or package-registry publication
- Versions: root, extension, server, protocol, VSIX, and server archive are `1.0.0`
- Supported runtime: standard trusted local VS Code Desktop on macOS and Linux
- Explicit future runtime: Windows, remote, web, virtual, and sandboxed workspaces

## What is implemented

The active contract is `vscode-mcp.tools/1.0.0`: 39 MCP tools, of which 38 are extension
capabilities. It provides bounded repository discovery, dirty-buffer-aware search and
batch reads, editor state, diagnostics, symbols, navigation, completion, code actions,
hierarchy, hints, folds, selections, links, version-checked atomic text edits,
create/move/delete/save/revert, provider-backed rename/format/edit-only actions,
configured tasks, and exact named launch/run configurations.

Read enablement never grants mutation or execution. Write and task/debug permissions are
separate visible memory-only extension-session grants. Revocation invalidates
generations, preview handles, queued work, and tracked execution. Preview handles are
random, bounded, expiring, workspace/grant-bound, and single-use. Task IDs are opaque
and rediscovered before start. Debug starts are restricted to one exact configured,
startable launch name and correlated back to the selected workspace. Compound configs
are visible but non-startable because VS Code's stable API exposes no safely scoped
aggregate child-session stop handle.

The product has no generic shell, terminal input, Git control, arbitrary
`executeCommand`, DAP evaluation/custom request, HTTP listener, telemetry, overwrite, or
recursive deletion surface. Configured tasks and launch configs are the reviewed
execution boundary.

## Verification snapshot

- `pnpm check`: 46 test files / 433 tests, format, ESLint, and all workspace typechecks.
- Extension Host: 13 complete workflows on VS Code stable, including all 39 tools,
  language providers, write/provider/file lifecycle, task/debug lifecycle, authority,
  output bounds, arbitrary-dispatch rejection, and cancellation/lifecycle races.
- Scanner spike: 16 scenarios; write spike: 6 race/atomicity scenarios.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- Release verifier: deterministic TAR/ZIP, exact file sets and modes, structurally
  parsed active VSIX XML, whitespace-preserving archive names, connected CycloneDX
  dependency graph, exact checksums, notices, licenses, and clean-cache installed-pair
  tests.
- Exact packaged-pair runs and reproducibility hashes are recorded in
  `docs/security-acceptance-report-v1.0-full-ide.md`.
- Packaged-pair discovery uses a unique owner-only short runtime directory, so a live
  enabled VS Code window cannot contaminate the isolated release test.

## Local artifacts

`artifacts/release-1.0.0/` is generated from the current working tree. It contains the
version-matched VSIX and standalone server archive, CycloneDX SBOM, release manifest,
SHA-256 checksums, installation and agent guides, contract, security policy, license,
privacy/support policies, notice, and third-party notices. It is a local candidate, not
permission to publish.

## Publication boundary

Private creation and initial push of `kennywillbe/vscode-mcp` are authorized. Public
visibility, signing/tagging, GitHub Release assets, and Marketplace publication remain
maintainer-controlled action-time gates. The exact GitHub Release VSIX—not a rebuild—is
the Marketplace upload input. Open VSX and package registries remain prohibited.

## Windows follow-up

Windows intentionally fails closed before listener or registry publication. The native
owner-SID/DACL feasibility, two-account adversarial tests, packaging, and promotion
gates are specified in `docs/windows-support-plan.md`; none is silently treated as 1.0
support.
