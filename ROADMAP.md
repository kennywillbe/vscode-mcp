# vscode-mcp roadmap

`vscode-mcp` is a secure local bridge that gives coding agents bounded access to VS
Code's live IDE capabilities. The first public version is `1.0.0`; development remains
local until the maintainer explicitly starts the GitHub publication stage.

## Current status

| Area                                    | Status                                     |
| --------------------------------------- | ------------------------------------------ |
| macOS/Linux 1.0 product                 | Complete locally                           |
| 39-tool MCP contract                    | Complete and frozen                        |
| Security and release-candidate evidence | Complete locally                           |
| Private GitHub setup                    | Authorized; pending execution              |
| First public GitHub release             | Pending maintainer approval                |
| VS Code Marketplace 1.0                 | Pending publisher setup and public release |
| Windows desktop support                 | Planned after 1.0                          |

## Completed for 1.0

- pnpm/TypeScript monorepo with separate protocol, VS Code extension, and MCP bridge
  packages.
- Authenticated, user-scoped Unix-socket IPC for trusted local macOS/Linux VS Code
  workspaces.
- Deterministic multi-window and multi-root selection with canonical path enforcement.
- Bounded repository discovery, dirty-buffer-aware reads, batch reads, and literal text
  search.
- Complete structured language intelligence: diagnostics, navigation, symbols,
  completions, code actions, highlights, hierarchies, hints, folds, selections, and
  links.
- Separate visible session grants for writes and configured execution.
- Version-checked multi-document text edits, non-overwriting file operations,
  save/revert, rename, formatting, and text-edit-only code-action application.
- Configured VS Code task execution and exact named run/debug configurations without a
  generic shell, terminal input, arbitrary VS Code command, Git control, or arbitrary
  DAP request.
- Unit, IPC, Extension Host, scanner/write race, packaging, SBOM, license, deterministic
  archive, and exact installed-pair test coverage.
- GitHub Release distribution for the complete product plus publication of the exact
  verified VSIX to the VS Code Marketplace. Other registries remain prohibited.

The active product contract is
[`docs/tool-contract-v1.0.md`](./docs/tool-contract-v1.0.md). The current security
disposition is recorded in
[`docs/security-acceptance-report-v1.0-full-ide.md`](./docs/security-acceptance-report-v1.0-full-ide.md).

## Private GitHub setup

**Status: Authorized**

1. Create `kennywillbe/vscode-mcp` as a private repository.
2. Push the reviewed initial history and run the pinned CI matrix.
3. Configure repository metadata, Discussions, Dependabot, Actions permissions, and the
   strongest available main/tag rules for the account plan.
4. Review security scans, workflow logs, rendered docs, and release artifacts while the
   repository remains private.

## Release 1.0 — public GitHub and Marketplace publication

**Status: Pending**

This stage starts only after explicit maintainer approval:

1. Change the reviewed repository visibility to public.
2. Enable GitHub Private Vulnerability Reporting and verify the public security policy.
3. Push the signed `v1.0.0` tag.
4. Publish the version-matched checksummed assets in one GitHub Release.
5. Verify installation from the public GitHub Release.
6. Upload the exact GitHub Release VSIX to the VS Code Marketplace.
7. Verify the Marketplace listing, install flow, server guidance, and extension
   identity.

Private repository creation and its initial push are authorized. Public visibility,
tagging, GitHub Release creation, and Marketplace upload still require separate
approval.

## Windows desktop support

**Status: TODO after 1.0**

Windows remains fail-closed before listener or registry publication. It is not a hidden
or partially supported 1.0 path. A future release must complete all of the following:

- accept a Windows-local IPC and owner-ACL design;
- implement owner-scoped named-pipe and registry security without a permissive window;
- test discovery, authentication, lifecycle, all 39 tools, installation, and cleanup on
  real Windows hosts;
- run distinct-account negative tests and path/case/reparse-point escape tests;
- extend packaging, CI, threat modeling, and installation guidance; and
- pass the same source and exact-artifact gates as macOS/Linux.

The implementation work packages and promotion gates are in
[`docs/windows-support-plan.md`](./docs/windows-support-plan.md). The selected native
boundary is recorded in
[`docs/windows-ipc-decision.md`](./docs/windows-ipc-decision.md).
