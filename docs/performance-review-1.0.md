# Performance and resource review for 1.0

- Review scope: local 1.0 release candidate
- Date: 2026-07-10
- Status: Complete for the supported macOS/Linux runtime

This review checks that untrusted inputs cannot create unbounded buffering, provider
fan-out, queue growth, or result serialization in the extension or bridge. Version 1.0
does not define a latency service-level objective because language-provider latency is
owned by the installed VS Code extensions. It does define hard resource ceilings and
deadlines.

## Bounded transport and discovery

- MCP newline input is rejected before JSON parsing above 256 KiB.
- IPC `Content-Length` headers are bounded at 8 KiB. Directional bodies are validated
  before allocation at 256 KiB bridge-to-extension and 2 MiB extension-to-bridge.
- Registry records are rejected before JSON parsing above 64 KiB. Discovery considers at
  most 64 records and authenticates endpoint probes in batches of four.
- One endpoint probe, including connection and hello, has a three-second deadline. The
  deliberate four-probe ceiling limits file descriptors and handshake work. In the
  pathological case of 64 unreachable but otherwise valid same-user records, discovery
  can take up to 16 batches; this is bounded but intentionally favors resource safety
  over lowest latency.
- Registry heartbeats are atomic replacements every five seconds. Discovery never polls
  continuously and the project starts no background bridge process.

## Scheduling and provider work

One extension window admits at most four connections, four active calls per connection,
eight active calls in total, and sixteen queued calls. The seventeenth waiting call is
rejected. Queue time is part of the five-second simple-tool or fifteen-second provider
deadline. Timeout, cancellation, disconnect, disable, and shutdown settle client and
queued accounting promptly. An active, non-cancellable VS Code/host promise retains its
actual execution slot until it settles; only then is that slot released once and the
oldest eligible queued job admitted. Late values are always discarded. A permanently
stuck provider can occupy at most four slots for one connection and eight for one
window, rather than allowing repeated cancellation to accumulate detached work.

Provider arrays are copied only by numeric index to explicit raw budgets before
normalization; no provider-owned array is mapped, sliced, spread, searched, or iterated
first. The request-wide limits include 8,000 diagnostics, 8,000 document-symbol nodes at
depth 128, 4,000 references, 2,000 workspace symbols, and 1,000 calls plus 4,000
call-site ranges per direction. Diagnostic tags/related information, hover contents,
signature parameters, and call-site ranges also have independent per-item and global
nested budgets. Public schemas apply their narrower limits afterward. Diagnostics'
freshness snapshot reads no diagnostic item, so final normalization remains within one
request-wide 8,000-item traversal.

## Documents and serialized output

- Editor, open-document, and tab adapters wrap at most 8,000 raw host entries lazily;
  tab documents are resolved one at a time. Public editor/diagnostics collections remain
  capped at 200 with explicit adapter-level omissions.
- A closed document larger than 10 MiB is rejected before the editor/document tools open
  it. Already-open buffers are read only through bounded line chunks.
- `read_document` returns at most 256 KiB UTF-8 and does not split a Unicode scalar.
- Diagnostic messages are at most 16 KiB; reference contexts are at most 4 KiB; combined
  hover and signature text is at most 64 KiB.
- Location-heavy language tools apply an intermediate 384 KiB collection budget.
- Every extension success passes a final deterministic reducer at 500 KiB. Optional
  related information, contexts, documentation, and call-site ranges are removed before
  tail results. The bridge then measures the complete MCP response against the canonical
  512 KiB ceiling. Every reduction sets explicit warning/truncation metadata; an
  irreducible value fails closed.

The reducer uses bounded prefix searches and repeated serialization of an already
bounded value. It does not retain full serialized copies beyond the operation.

The complete IDE surface adds independent ceilings: 32 documents, 2,048 total edits, 512
edits per document, 2 MiB aggregate replacement text, 2 MiB create content, 32
one-minute preview handles, 200 listed/four active tasks, four tracked debug sessions,
and 30-minute task lifetime. Additive provider values use a bounded depth/key/array/text
projection and a 192 KiB working budget; code-action previews share 128 KiB. New
structured successes remain below the 448 KiB target before the inherited 512 KiB MCP
envelope ceiling.

## Validation evidence

- The final macOS working tree passed 46 test files / 431 tests, format, lint, workspace
  typechecks, production builds, and a high-severity dependency audit on Node.js
  `22.21.1` and pnpm `10.24.0`.
- A clean Linux container repeated the complete 46-file/431-test suite and production
  builds using exact Node.js `22.13.0` and pnpm `10.24.0`. The pnpm static executable
  was verified against the release asset's SHA-256 digest before a frozen dependency
  installation; the audit reported no known vulnerabilities.
- After that full-suite checkpoint, the expanded IPC service file passed 19/19 focused
  tests with extension typecheck and lint green. Its real-socket terminal-winner matrix
  makes completion, cancellation, timeout, and disconnect win first in turn, delivers
  all remaining events late, proves a single terminal response or none after disconnect,
  and verifies abort, counter, write-after-close, and subsequent-admission safety.
- Boundary tests cover actual exact/plus-one real-socket 256 KiB and 2 MiB IPC frames,
  malformed framing over real sockets, exact serialized tool arguments before IPC,
  actual MCP stdin, schema-valid 64 KiB registry records, document text, collection
  reduction, and complete MCP output envelopes.
- Real POSIX socket tests authenticate four simultaneous clients, drive eight active and
  sixteen queued calls, reject the seventeenth waiter, cancel queued work before its
  handler starts, and stop active and queued work without leaking capacity.
- Authenticated `closeSession` tests run six sequential bridge-style sessions and prove
  the acknowledgement and peer close complete before the next session consumes an
  admission slot.
- The thirteen-test extension-host suite starts the bundled bridge and invokes all 39
  tools. CI covers the minimum VS Code `1.101.0` API axis on Linux and the macOS
  platform axis on stable VS Code; local Apple Silicon evidence additionally passes both
  versions.
- The same thirteen scenarios passed from an installed VSIX and separately extracted
  server archive on clean Linux `amd64` at VS Code `1.101.0` and stable, and on macOS
  Intel at stable. Local Apple Silicon runs cover both `1.101.0` and stable. That
  artifact snapshot predates later source and documentation changes; it is performance
  evidence, not the final candidate acceptance result.
- Deterministic scheduler/service regressions cancel, disconnect, and time out repeated
  waves while the original host promises remain pending. They prove no ninth execution
  starts, client outcomes remain single, delayed completion after an absolute deadline
  is `TIMEOUT`, and capacity releases exactly once only after raw settlement.
- Cap-plus-one accessors, sparse arrays, nested diagnostic/hover/signature payloads,
  deep/cyclic symbol trees, and per-item/global call-range limits prove that raw and
  public collection budgets are independent and explicit.
- Runtime instrumentation runs the real bundled bridge child with the real IPC service
  across success, internal failure, timeout, cancellation, authentication failure, and
  cleanup. It observes network, child-process, and filesystem surfaces and leaves the
  isolated runtime fixture empty.
- Production builds are minified single-file bundles. Release tests verify deterministic
  archives, embedded versions, safe exact standalone contents, tar ownership/modes,
  checksums/manifests, SBOM output, and license inclusion; the server archive has no
  runtime package-installation or native postinstall step.

The formal pre-remediation security snapshot reported one low-severity
detached-provider-work finding. The split client/execution lifecycle and raw-promise
retention described above remediate it in the current source. VS Code necessarily
allocates provider command results before returning them to this extension; the review
claim begins at that API boundary. No unresolved unbounded extension-owned traversal,
memory, or concurrency path remains in the reviewed macOS/Linux implementation. Changes
to limits, transports, provider commands, or tool schemas require updating the accepted
contracts and their boundary tests together.
