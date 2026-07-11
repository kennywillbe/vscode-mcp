# Repository instructions for coding agents

This file applies to the entire repository. Every agent must read it before changing
code, documentation, workflows, dependencies, or release artifacts.

Do not delete, rename, bypass, or weaken this file without explicit maintainer approval.
If a task conflicts with these rules, stop and explain the conflict instead of silently
working around it.

The words **MUST**, **MUST NOT**, **SHOULD**, and **SHOULD NOT** are normative.

## Start here

Before making a change, read:

1. `AGENTS.md`
2. `README.md`
3. `ROADMAP.md`
4. The relevant files in `docs/adr/`
5. `docs/security-model.md` for anything touching IPC, paths, authentication, logging,
   workspace selection, or VS Code APIs
6. `docs/tool-contract-v1.0.md` for complete-product MCP tools or their results; consult
   the inherited v0.1/v0.2 baselines only when the active contract references them

Inspect the working tree before editing. Existing changes belong to the maintainer or
another agent and MUST be preserved. Keep changes scoped to the requested task.

## Project mission and non-negotiable boundaries

`vscode-mcp` exposes VS Code's live editor state and language intelligence to MCP
clients through a secure local bridge.

- The complete 1.0 product includes bounded read, language-intelligence, workspace
  mutation, configured task, and named run/debug tools under separate session grants.
- The MCP process uses `stdio`; the extension side uses authenticated, user-scoped local
  IPC.
- The extension is the authorization authority. The bridge is never trusted to enforce
  workspace scope.
- Only explicitly enabled, trusted, local desktop workspaces are eligible.
- Files and provider results outside the selected workspace are never exposed.
- Arbitrary shell strings, terminal input, Git control, arbitrary `executeCommand`, DAP
  custom requests, command-bearing provider actions, overwrite, and recursive deletion
  remain out of scope. Configured VS Code tasks, named run/debug configurations, and
  fully inspectable workspace mutations are in scope only through accepted contracts.
- Read enablement never implies write or execution authority. Write and execution grants
  are off by default, visible, session-scoped, independently revocable, and owned by the
  extension.
- No HTTP/SSE listener, telemetry, analytics, or persistent content logging is allowed.
- Remote SSH, WSL, Dev Containers, Codespaces, virtual workspaces, and VS Code for the
  Web are unsupported until separately designed and approved.

Changing one of these boundaries requires an explicit maintainer decision, an ADR, a
security-model update, and corresponding tests.

## Toolchain

- Use Node.js 22 and the pnpm version pinned in the root `package.json`.
- pnpm is the only package manager for this repository.
- MUST NOT run `npm install`, Yarn, or Bun, and MUST NOT add their lockfiles.
- Use `corepack` when pnpm is not already available.
- Update `pnpm-lock.yaml` only through pnpm.
- Do not hand-edit generated output, lockfile entries, VSIX files, or bundled
  JavaScript.
- Do not commit `node_modules`, `dist`, `out`, `.vscode-test`, `coverage`, `artifacts`,
  local environment files, or secrets.

Common commands:

```sh
pnpm install --frozen-lockfile
pnpm audit
pnpm check
pnpm build
pnpm test:extension
pnpm package:vsix
```

Use `pnpm install` without `--frozen-lockfile` only when intentionally changing
dependencies.

## Package responsibilities

- `packages/extension` owns VS Code APIs, Workspace Trust, editor/document state,
  language providers, canonical path authorization, and the local IPC listener.
- `packages/server` owns MCP `stdio`, instance discovery and selection, IPC client
  behavior, MCP tool registration, and conversion to MCP responses.
- `packages/protocol` is a private, source-only workspace package. It owns shared
  protocol constants, schemas, wire types, and stable error codes. It MUST NOT depend on
  VS Code or the MCP SDK.

Do not blur these boundaries for convenience. Shared code belongs in `protocol` only
when both processes genuinely need the same wire-level concept.

## Engineering principles

Apply these principles together; none is permission to over-engineer.

- **SOLID:** keep modules cohesive, depend on narrow interfaces at process boundaries,
  and extend behavior without growing central switch statements or god objects.
- **DRY:** centralize shared invariants, schemas, limits, and error codes. Do not
  extract abstractions merely because two short snippets look similar.
- **KISS:** prefer the smallest explicit design that is easy to audit.
  Security-sensitive behavior should be visible, unsurprising, and testable.
- **YAGNI:** do not add transports, compatibility layers, configuration flags, remote
  modes, write tools, or generic frameworks before an accepted requirement exists.
- Prefer composition over inheritance and pure transformations over hidden mutable
  state.
- Make invalid states difficult to represent. Validate all data received across a
  process or trust boundary.
- Optimize for correctness and auditability before cleverness or micro-optimization.

## TypeScript and API rules

- Keep TypeScript strict. Do not introduce `any`, unsafe casts, `@ts-ignore`, or
  disabled lint rules to make a change pass.
- Use `unknown` at trust boundaries and validate it with the shared Zod schemas before
  use.
- Keep public interfaces small and explicitly typed.
- Use structured errors with stable codes; do not make clients parse error-message
  strings.
- Propagate cancellation and enforce the documented concurrency, timeout, input, and
  output limits.
- Never silently truncate. Return explicit truncation metadata and warnings.
- Preserve zero-based UTF-16 position semantics and half-open ranges used by VS Code.
- Avoid module-level mutable state unless it is the deliberate owner of a documented
  lifecycle.
- `stdout` in the server process is reserved for MCP protocol traffic. Diagnostics and
  logs go to `stderr`; extension logs go to a VS Code Output Channel.

## Security rules

- Treat registry files, IPC frames, MCP arguments, filesystem paths, language-provider
  output, hover Markdown, diagnostics, and workspace content as untrusted input.
- Canonicalize and `realpath` filesystem targets. Enforce containment with
  platform-aware path logic, never string-prefix checks.
- Re-check authorization in the extension for every request, including locations
  returned by language providers.
- Never log session tokens, endpoint secrets, source content, selection text, hover or
  diagnostic bodies, absolute user paths, environment variables, or full
  request/response payloads.
- Generate secrets with cryptographically secure randomness and compare authentication
  tokens in constant time.
- Use restrictive user-only permissions for runtime directories, registry entries,
  sockets, and named pipes.
- Do not add a dependency, network call, listener, command execution path, or new data
  exposure without documenting its threat impact.
- Security annotations such as MCP `readOnlyHint` are descriptive and never replace
  enforcement.

## Tool-contract changes

The active 1.0 tool list and wire behavior are the public product contract. The v0.1 and
v0.2 documents are retained only as inherited technical baselines and decision history.

- Do not add, rename, or remove a tool without maintainer approval.
- Update the contract document and shared schemas before or with implementation.
- Keep tool inputs narrow, deterministic, and bounded. Read annotations must match
  reality; mutation and execution require the extension-owned grants defined by the 1.0
  contract.
- Add schema tests, success-path tests, limit tests, cancellation/timeout tests, and
  workspace-escape tests for every implemented tool.
- Contract-breaking changes require a contract version change and migration notes.

## Dependencies

- Prefer Node.js and VS Code platform APIs over new packages.
- Every runtime dependency needs a concrete justification and license review.
- Pin direct dependencies exactly unless an ADR documents another policy.
- Run `pnpm audit` after dependency changes and resolve high-severity advisories before
  completing the task.
- Keep `THIRD_PARTY_NOTICES.md` accurate for every dependency bundled in a release
  artifact.
- Do not introduce install scripts or native binaries without explicit review.

## Tests and definition of done

At minimum, a code change is not complete until:

1. `pnpm check` passes.
2. `pnpm build` passes.
3. Relevant unit and integration tests pass.
4. Extension-host behavior is tested when VS Code APIs or packaging change.
5. Security boundaries and failure paths have tests, not only happy paths.
6. Documentation and ADRs match the implemented behavior.
7. No generated, sensitive, or unrelated files are left in the change.

Bug fixes SHOULD include a regression test. Do not weaken, skip, or delete a failing
test unless the maintained contract itself intentionally changes.

## Documentation and decisions

- Record material architecture, transport, trust-boundary, compatibility, or
  distribution decisions as ADRs.
- State whether an ADR is `Proposed`, `Accepted`, `Superseded`, or `Rejected`.
- Keep `README.md` factual. Do not describe planned behavior as already implemented.
- Keep `ROADMAP.md` statuses and release gates current.
- When documentation and code disagree, do not guess silently: determine which is the
  accepted contract and update both together.

## Distribution and publishing

- The maintainer has authorized creation of `kennywillbe/vscode-mcp` as a private GitHub
  repository for final setup. Do not change it to public, tag, create a release, upload
  an artifact, or publish a Marketplace item without separate action-time maintainer
  approval.
- The first public repository state, GitHub Release, and Marketplace version are
  `1.0.0`; there are no public preview or `0.x` releases.
- GitHub Releases are the canonical complete-product distribution. They contain the
  version-matched VSIX and server archive, checksums, SBOM, licenses, notices, and
  installation/configuration documentation.
- ADR 0008 also permits the exact already-verified GitHub Release VSIX to be uploaded to
  the VS Code Marketplace after the repository and GitHub Release are public.
- Marketplace publication MUST NOT rebuild or mutate the VSIX. The listing must state
  that the matching server is installed separately from GitHub.
- Version 1.0 Marketplace upload is manual. MUST NOT store a Marketplace PAT or publish
  token in the repository or GitHub secrets. Future automation requires an accepted
  Microsoft Entra workload-identity design.
- MUST NOT publish to Open VSX, npm, JSR, Yarn, Bun, or another package registry.
- The extension and server are two parts of one product and MUST preserve the accepted
  IPC/tool compatibility boundary across Marketplace updates.
- Auto-update services implemented by this project and telemetry remain prohibited.
- A locally generated scaffold VSIX is not a public release artifact until every gate in
  `ROADMAP.md` is complete.
