# Local 1.0 release-candidate process

This process creates the exact files for a coordinated GitHub Release and supplies the
unchanged VSIX for manual Marketplace upload. It does not create a repository, tag,
GitHub Release, Marketplace listing, or package-registry publication. Publication
remains a separate, explicit maintainer-approved action.

## Preconditions

Use a clean reviewed source snapshot with Node.js 22 and the pnpm version pinned in
`package.json`. Before packaging, confirm the accepted contracts, security evidence,
static checks, Extension Host tests, and packaged-pair tests are current. The script
enforces the mechanical version gate: the root, extension, server, and protocol package
manifests must all be exactly `1.1.0`. It exits before building or writing artifacts if
any version differs.

Install and validate the exact locked dependency graph:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm audit
pnpm check
pnpm build
pnpm test:extension
```

The extension-host suite builds the server CLI before launching VS Code, so it also
tests the same `dist/cli.mjs` entry point shipped in the server archive.

## Build the candidate

Run one orchestration command from the repository root:

```sh
pnpm package:release
```

The command performs these operations in order:

1. Verifies that every workspace package is version `1.1.0`.
2. Removes stale bundle outputs, then builds the server and extension production
   bundles.
3. Reads the exact extension and server production dependency graph from pnpm.
4. Regenerates the reviewable root `THIRD_PARTY_NOTICES.md` from installed package
   metadata and full dependency license files.
5. Produces a normalized, versioned VSIX and a deterministic server `tar.gz`.
6. Generates a CycloneDX 1.5 JSON SBOM, release manifest, and SHA-256 checksums.
7. Re-reads every manifest entry and checksum, enforces the exact payload roles and
   media types, and verifies the SBOM component/dependency-reference coverage before
   accepting the candidate.

On success, all candidate files are in `artifacts/release-1.1.0/`. A failed run removes
its temporary staging directory. A successful rerun replaces only that versioned release
directory; unrelated files in `artifacts/` are preserved.

## Candidate contents

- `vscode-mcp-extension-1.1.0.vsix`: sideloadable VS Code Desktop extension containing
  the exact SHA-256-manifested server used by the explicit client setup command.
- `vscode-mcp-server-1.1.0.tar.gz`: platform-neutral bundled Node.js CLI under the
  `vscode-mcp-server/` archive root.
- `vscode-mcp-1.1.0.cdx.json`: CycloneDX 1.5 production dependency graph.
- `release-manifest.json`: file roles, compatibility bounds, byte sizes, and SHA-256
  digests for all candidate payloads.
- `SHA256SUMS`: digests for every file in the candidate directory except itself.
- `README.md`, `INSTALLATION.md`, `RELEASE_NOTES.md`, `SECURITY.md`, `PRIVACY.md`, and
  `SUPPORT.md`: release, reporting, privacy, and support documentation.
- `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`: project and bundled dependency
  licensing.

The server archive itself contains executable `cli.mjs`, a minimal versioned
`package.json`, its README, the installation and security guides, and the same license
and notice files. If esbuild emits a legal-comments sidecar, that file is included too.

## Reproducibility controls

The release scripts do not use the clock, current user, host path, uid, or gid in
artifacts. Tar members are sorted and have fixed modes, uid/gid zero, and Unix-epoch
timestamps. Gzip time and operating-system metadata are fixed. The VSIX ZIP is re-read,
CRC-checked, sorted, and rewritten with fixed compression, modes, and DOS timestamps.
JSON arrays are sorted, and the SBOM serial number is derived from its dependency graph
rather than randomness.

To check reproducibility, save the first `SHA256SUMS`, run `pnpm package:release` again
from the same reviewed checkout and lockfile, and compare the two checksum files byte
for byte. A difference is a release blocker and must be explained before publication.

`THIRD_PARTY_NOTICES.md` is generated source material. Review its dependency set,
license identifiers, source links, and complete license texts. If regeneration changes
the tracked file, review that change and rebuild the candidate from the reviewed tree.
Do not hand-edit the generated file.

`verifyReleaseDirectory` opens both executable archives after checksum validation. It
requires the exact safe VSIX/server file sets, embedded 1.1.0 identities and engine
ranges, fixed tar ownership/modes/timestamps, an executable Node shebang, and production
bundles without source maps or source-tree paths. Checksummed but malformed placeholder
archives are rejected.

After packaging, run the existing extension-host scenarios against the installed VSIX
and extracted server archive on both supported VS Code bounds:

```sh
VSCODE_TEST_VERSION=1.101.0 pnpm test:artifacts
VSCODE_TEST_VERSION=stable pnpm test:artifacts
```

This uses a separate test-harness extension so the source extension is not loaded as a
development extension. All 39 tools therefore cross the exact packaged MCP, IPC, and
VSIX boundary.

## Final acceptance

On clean macOS and Linux machines in the supported matrix:

1. Verify `SHA256SUMS`.
2. Inspect the server archive paths and extract it as a normal user.
3. Sideload the version-matched VSIX.
4. Follow [the installation guide](./installation.md) without source-tree assumptions.
5. Enable only a trusted local workspace, explicitly grant write and execution for the
   relevant scenarios, and exercise all 39 tools including representative multi-document
   edit, rename, configured task, and named debug workflows.
6. Confirm upgrade, coordinated downgrade, disable, and complete removal.
7. Confirm no network listener, project updater, telemetry, background service, or
   ungranted mutation/execution path appears.

Record the operating system, architecture, VS Code version, Node.js version, artifact
digests, and result in the final review. Do not modify an artifact after review; rebuild
the full set instead.

## Publication boundary

`pnpm package:release` intentionally has no upload, tag, publish, or GitHub API path.
After final acceptance, create the approved versioned GitHub Release. The VSIX and
server archive must be attached together with every supporting file from the same
candidate directory. After the public GitHub Release is verified, upload that exact VSIX
file to the Marketplace portal without rebuilding it. Record and compare its SHA-256
digest before upload. Version 1.0 stores no Marketplace PAT or publish credential in
GitHub.
