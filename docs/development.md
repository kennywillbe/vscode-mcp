# Local development

This guide covers source development and unpublished local installation. It does not
create a release, publish a package, or change an MCP client's configuration.

## Prerequisites

- macOS or Linux
- Node.js `>=22.13.0 <23`
- pnpm `>=10.24.0 <11`
- VS Code Desktop 1.101.0 or newer for extension development

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
```

`pnpm doctor` checks the supported platform, pinned toolchain, workspace files, and the
optional VS Code CLI. A missing `code` command is only blocking when installing the
local VSIX from the command line.

## Watch loop

Run all three package watchers with:

```sh
pnpm dev
```

The command performs one complete build first, then watches protocol types, extension
types and bundle, and server types and bundle. In VS Code, the default **Run vscode-mcp
Extension (watch)** launch configuration starts the same task and opens the fixture
workspace in an Extension Development Host.

Watch mode rebuilds files but cannot replace code already loaded into another process:

- after an extension change, restart the Extension Development Host or run **Developer:
  Reload Window** there;
- after a server change, restart or reconnect the MCP client so it starts the rebuilt
  `cli.mjs`;
- protocol changes normally require both reloads.

For fast unit-test feedback, run `pnpm test:unit:watch` in a second terminal.

## Local installation and packaged-pair test

Build a production server bundle, create an unpublished VSIX, and generate an MCP
configuration snippet under ignored `artifacts/local/`:

```sh
pnpm setup:local
```

Install or replace the extension in the local VS Code profile at the same time:

```sh
pnpm setup:local -- --install
```

The script prints the exact VSIX, server, and generated configuration paths. It does not
edit an MCP client's settings because clients use different files and schemas. Review
and copy the generated `mcp-config.json` entry into the intended client, open a trusted
local workspace, and run **VS Code MCP: Enable for This Workspace**.

Use the separate write and task/debug session commands only for tests that need those
capabilities. A window reload deliberately revokes them, so hot-reload testing must
grant them again after the extension restarts.

Test the exact local VSIX/server pair in an isolated VS Code Extension Host with:

```sh
VSCODE_TEST_VERSION=stable pnpm test:local
```

This test clears its VS Code test installation/cache before and after each run. The
files in `artifacts/local/` remain development outputs, not release candidates.

The explicit `onCommand:vscode-mcp.*` activation events in the extension manifest are
intentional even when VS Code reports that command contributions can generate them.
`onStartupFinished` is also required for previously enabled workspaces, and exact-VSIX
tests prove that retaining only that startup event leaves packaged command invocations
without extension activation. Do not remove the explicit command events without an exact
packaged-pair regression proving both startup and command activation.

## Before review

```sh
pnpm check
pnpm build
pnpm test:extension
pnpm audit
```

Read [AGENTS.md](../AGENTS.md) before changing code or documentation. Release artifact
production remains a separate gated process described in
[release-process.md](./release-process.md).
