# Security Policy

## Supported versions

`vscode-mcp` has not published a release yet. Security fixes will initially be made on
the default branch and included in the next GitHub release artifact.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability report](https://github.com/kennywillbe/vscode-mcp/security/advisories/new)
and include:

- The affected revision or release.
- Reproduction steps or a proof of concept.
- The expected security boundary and observed impact.
- Any suggested mitigation.

No telemetry, file contents, access tokens, or local paths should be attached unless
they are essential and have been redacted.

## Security baseline

- No network listener is enabled by default.
- Read, write, and configured execution are independent extension-owned capabilities;
  write and execution grants are off by default and memory-only.
- Arbitrary shell, terminal input, Git control, VS Code command dispatch, and DAP
  requests are out of scope.
- An untrusted VS Code workspace is never exposed.
- Requests are constrained to the selected workspace and bounded by time and output
  limits.

The complete 1.0 trust model is maintained in `docs/security-model-v1.0-full-ide.md`,
with the inherited transport/read boundary in `docs/security-model.md`.
