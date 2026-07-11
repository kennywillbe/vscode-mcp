# Dependency and license review for 1.0

- Date: 2026-07-10
- Lockfile: `pnpm-lock.yaml`
- Package manager: pnpm 10.24.0
- Runtime: Node.js 22.13.0 or newer in the Node.js 22 line

All direct dependency versions are exact and the release build uses
`pnpm install --frozen-lockfile`. No runtime dependency uses an install script or ships
a project-owned native binary. The only allowed build dependency with an installation
step is the pinned `esbuild` development tool declared in `pnpm.onlyBuiltDependencies`;
it is not installed by users of the bundled server archive.

## Direct production dependencies

| Dependency                  | Owner                       | Reason retained                                                                                                                          |
| --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | server                      | Official MCP schemas, server lifecycle, tool registration, and `stdio` protocol behavior.                                                |
| `vscode-jsonrpc`            | extension, server, protocol | Request IDs, cancellation, and connection dispatch over the project's custom bounded IPC framing.                                        |
| `zod`                       | server, protocol            | Strict validation of every MCP, registry, handshake, IPC, and tool boundary.                                                             |
| `@vscode-mcp/protocol`      | extension, server           | Private source-only workspace package containing the shared versioned contract; it is not a third-party package or registry publication. |

VS Code itself is a host API and is not bundled. Node.js built-ins implement local
sockets, files, paths, hashing, randomness, streams, archives, and checksums; separate
packages were not added for those operations.

## Audit and licenses

`pnpm audit --audit-level=high` reported no known vulnerabilities on the reviewed
lockfile. `pnpm licenses list --prod --json` classified installed production packages as
MIT, ISC, BSD-2-Clause, or BSD-3-Clause; no copyleft or unknown production license was
reported.

The final local graph review found 98 production components in total: three workspace
components plus 95 external dependencies, connected by 169 graph edges beneath the
release root. The external license inventory and generated-notice inventory matched all
95 components exactly: MIT 85, ISC 7, BSD-3-Clause 2, and BSD-2-Clause 1.

The release script does not rely only on this summary. It traverses the exact pnpm
production graph for both bundled products, records every component and edge in the
CycloneDX 1.5 SBOM, and copies each installed dependency's complete license/notice files
into generated `THIRD_PARTY_NOTICES.md`. Packaging fails if a bundled dependency lacks a
readable license file. Local package paths are excluded from the notices, SBOM,
manifest, and artifacts.

## Review policy

A dependency addition or upgrade must have a concrete platform/API justification, an
exact version, a high-severity audit, license review, updated notices/SBOM, and relevant
boundary tests. Native modules, postinstall scripts, network clients, telemetry SDKs,
alternate transports, and generic command-execution libraries require explicit
maintainer and threat-model review before they enter the lockfile.
