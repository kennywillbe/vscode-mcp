# ADR 0008: GitHub and VS Code Marketplace distribution

- Status: Accepted
- Date: 2026-07-11
- Supersedes: ADR 0003

## Context

`vscode-mcp` has two versioned components: a VS Code extension and a standalone MCP
`stdio` server. GitHub Releases can distribute and attest the complete pair. The VS Code
Marketplace distributes only the extension, but materially improves discovery,
installation, signature verification, and extension updates.

Marketplace publication adds a publisher identity and a second release channel. It must
not create an unreviewed artifact, expose a long-lived publishing secret, or weaken the
exact contract and security gates. ADR 0009 later accepts including the exact verified
server bundle in the VSIX for explicit local client setup.

## Decision

- The public GitHub repository and GitHub Release remain the canonical source and
  complete-product distribution.
- Every release contains the checksummed VSIX, server archive, SBOM, licenses, notices,
  installation guide, and tool contract.
- The same verified VSIX bytes from the GitHub Release may also be uploaded to the VS
  Code Marketplace under the final publisher ID. Marketplace publication never rebuilds
  or mutates the extension.
- The Marketplace listing must describe the bundled setup command and link to the
  corresponding GitHub Release installation guide and standalone server archive.
- The server is not published to npm, JSR, Yarn, Bun, Open VSX, or another registry.
- Version `1.0.0` uses a manual Marketplace portal upload after the repository and
  GitHub Release are public and verified. No Marketplace credential is stored in GitHub.
- Future automated Marketplace publishing requires a separate accepted change using
  Microsoft Entra ID workload identity. Long-lived Azure DevOps PATs are not an
  acceptable release secret.
- GitHub is created private first. CI, repository metadata, rules, documentation, and
  release artifacts are reviewed there before visibility changes to public.
- GitHub Private Vulnerability Reporting is enabled immediately after the repository is
  public because GitHub exposes that feature only for public repositories.
- Marketplace publication occurs after the public GitHub Release so listing links,
  server downloads, support, privacy, and security reporting are available.
- Extension and server changes must preserve the advertised tool/IPC compatibility or
  ship as a coordinated release. Marketplace auto-update is not permission to introduce
  a contract mismatch.

## Release order

1. Push the reviewed source to the private GitHub repository.
2. Pass the pinned macOS/Linux CI and exact-artifact matrix.
3. Configure repository rules and metadata available to the account plan.
4. Change the repository to public and enable Private Vulnerability Reporting.
5. Create the signed `v1.0.0` tag and GitHub Release with the complete checksummed set.
6. Verify installation from the public GitHub Release.
7. Upload that exact VSIX to the VS Code Marketplace and verify the public listing.

## Consequences

- Marketplace users receive a signed, discoverable extension with an exact bundled
  server; manual installations can still use the matching GitHub server archive.
- GitHub remains the one location containing the complete product and provenance.
- A publisher ID, Marketplace-ready icon/listing, support and privacy links, and public
  repository URLs become release inputs.
- Release verification must compare Marketplace input bytes to the GitHub Release VSIX.
- Removing or renaming a Marketplace extension has lasting identity consequences and is
  never an automated maintenance action.
