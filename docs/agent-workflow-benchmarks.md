# Agent workflow benchmarks

- Status: Initial 1.0 implementation evidence
- Measured: 2026-07-11
- Environment: macOS arm64, VS Code stable 1.128.0 Extension Host, Node.js 22, local
  `vscode-mcp` workspace

These are real end-to-end acceptance-workflow observations, not cross-machine
performance claims. Each workflow traveled through MCP stdio, authenticated local IPC,
the production extension router, and real VS Code APIs. Suite time includes process and
provider scheduling; individual tool latency varies with the installed language
extensions and repository.

| Workflow                               | Verified operations                                                                                                                                                                                                           | Observed wall time |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: |
| Complete read/intelligence orientation | 39-tool discovery; instance/status; bounded file listing; document read; original and eight additive language-provider families                                                                                               |             3.42 s |
| Write lifecycle                        | denied write; grant; non-overwriting creates; missing/symlink-parent rejection; stale and overlapping atomic edit rejection; two-document edits; revert; revoked/single-use code-action previews; rename; move/delete; revoke |             5.54 s |
| Format/save/provider rejection         | provider formatting; dirty-buffer reread; version-checked save; opaque resource-operation code action rejection                                                                                                               |             1.01 s |
| Configured task lifecycle              | task discovery with command redaction; denied/forged/ambiguous run rejection; execution grant; run; status/exit/diagnostics; revoke                                                                                           |             1.61 s |
| Named run/debug lifecycle              | startable configuration discovery; denied/unknown start rejection; exact named no-debug start; correlated stop; stale-ID rejection; revoke                                                                                    |             2.24 s |
| Workspace authority negative flow      | outside path, prefix trap, external editor/tab filtering, allowed secondary root                                                                                                                                              |             1.56 s |

The measurements above are from the final source full-surface Extension Host run and are
rounded to the nearest 10 ms. They include the bridge's bounded 50 ms IPC
session-release settle and safe one-time retry for read-only transport races. Mutation
and execution requests are never retried after an ambiguous disconnect.

## Repository-scale scanner evidence

The extension-owned scanner's refreshed warm sample on this repository discovered 197
candidates, scanned 195 files and 2,238,029 text bytes, returned 535 matches with
context occupying 162,285 serialized bytes, and completed discovery plus scanning in
198.88 ms. A larger local TypeScript repository produced 201 candidates after the
deterministic generated/cache exclusions; 154 text candidates totaled 1,787,649 bytes.
These measurements are implementation evidence, not a claim that the MCP scanner is
faster than native `rg`.

## Workflow efficiency conclusions

- `read_documents` turns the measured five-file orientation set from five MCP calls into
  one and reduced its modeled envelope from 24,044 to 22,195 bytes.
- `list_workspace_files` and `search_workspace_text` are not marketed as faster than
  native ripgrep. Their value is dirty-buffer precedence, canonical authorization,
  deterministic policy, structured UTF-16 ranges, and removal of terminal parsing.
- Multi-document edits use one `workspace.applyEdit` commit. The acceptance workflow
  proves a stale second document leaves the first unchanged.
- Session grants add no per-edit modal round trip. One visible user command authorizes
  the bounded session capability until revoke or lifecycle loss.
- Configured task output is intentionally represented by lifecycle, exit code, and
  diagnostics rather than a non-portable promise of generic stdout capture.

## Reproduction

```sh
pnpm test:extension
pnpm research:scanner
```

The Extension Host test names are
`serves the complete 39-tool surface through MCP, IPC, and the extension`,
`enforces write grants and completes the file/edit lifecycle`, and
`lists and runs only configured tasks under the execution grant`. Release-candidate
evidence should refresh this table from the exact packaged pair on both supported
operating systems.
