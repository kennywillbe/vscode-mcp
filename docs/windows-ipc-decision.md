# Windows support deferred from 1.0

- Status: Accepted scope boundary
- Date: 2026-07-10
- 1.0 supported runtime: standard local VS Code Desktop on macOS and Linux

## Decision

Windows was not part of the requested version 1.0 product scope. Earlier drafts
incorrectly promoted a prospective Windows named-pipe design into a mandatory release
gate. That scope expansion is withdrawn.

Version 1.0 does not support Windows. The extension and runtime registry fail closed
before creating a listener or publishing a registry record, returning
`WINDOWS_ACL_NOT_IMPLEMENTED` at the platform boundary. There is no Unix-socket, TCP,
shell, or weaker-permission fallback.

The reserved Windows endpoint schema and portable path tests may remain because they are
useful future compatibility coverage. They do not claim runtime support and are not part
of the 1.0 acceptance denominator.

## Why the fail-closed boundary remains

The reviewed Node.js 22 `net.Server.listen` API exposes broad-read/write pipe switches,
but not a caller-supplied Windows security descriptor or effective-DACL verification.
Node/libuv therefore cannot establish and prove the same owner-only boundary provided by
the `0700`/`0600` Unix runtime using the reviewed pure-TypeScript architecture.

Using the default descriptor, treating a random name as authorization, or repairing a
live pipe afterward with PowerShell/`icacls` would weaken the boundary or add a
forbidden shell surface. The safe 1.0 behavior is to publish nothing.

Primary-source references and the original feasibility analysis remain in the
[security acceptance report](./security-acceptance-report-1.0.md#windows-future-enablement-note).

## Requirements before any future Windows support

Future Windows support requires a new, separately approved milestone and ADR covering:

1. a narrow native component or broker that obtains the current user's SID;
2. protected owner-only registry and named-pipe ACL creation before publication;
3. effective owner/DACL verification with Windows security APIs;
4. reproducible native builds, provenance, dependency/license review, and signing;
5. real tests from the owner and a distinct unprivileged Windows account; and
6. a threat-model and packaging review for the added native boundary.

Until all of those requirements pass, Windows remains explicitly unsupported and
fail-closed. This future work does not block the macOS/Linux 1.0 candidate and is owned
by the post-1.0 Windows milestone in [ROADMAP.md](../ROADMAP.md). The concrete phased
work packages and promotion gates are in the
[Windows support plan](./windows-support-plan.md).
