# ADR 0009: Bundled server and explicit client setup

- Status: Accepted
- Date: 2026-07-12
- Refines: ADR 0008

## Context

Requiring Marketplace users to separately download, verify, extract, and configure the
matching server made a local extension unnecessarily difficult to install. A container
would add host socket, UID, workspace-mount, and permission complexity while weakening
the reviewed user-scoped IPC boundary.

## Decision

- The exact production server bundle is included in the VSIX in addition to the
  standalone checksummed GitHub Release archive.
- An explicit **Set Up MCP Client** command verifies the bundled file against a
  versioned SHA-256 manifest and copies it to the extension's user-scoped global
  storage.
- Automatic Codex setup previews and owns one marked TOML block. It preserves unrelated
  content, creates an exclusive backup, rejects symlinks and config races, and writes
  atomically with user-only permissions.
- A fixed `node --version` probe may run against bounded explicit candidate paths.
  Arbitrary commands, shell parsing, PATH mutation, downloads, and background updates
  remain prohibited.
- Manual TOML and generic JSON copy modes remain available. Manually owned same-name
  config is never overwritten.
- Repair repeats verification and replaces only owned state. Removal deletes only the
  owned config block and extension storage directory.

## Consequences

Marketplace installation needs no second download or Docker container. Node.js 22.13 or
newer remains an explicit runtime prerequisite. The GitHub Release still carries the
standalone server, SBOM, checksums, and provenance, and the Marketplace still receives
the exact VSIX verified in that release.
