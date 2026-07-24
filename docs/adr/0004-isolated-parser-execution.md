# ADR 0004: Isolated Browser Parser Execution

Status: accepted for implementation, session wiring gated by evidence

Date: 2026-07-25

## Context

ADR 0003 keeps the `node-sql-parser` adapter internal and unwired. Its parser
is synchronous, so an `AbortSignal` cannot interrupt it while it occupies the
JavaScript thread. Even a late result that is correctly discarded can make an
editor unresponsive.

Moving the current adapter object into a worker is not valid. Parser requests,
authorities, ranges, artifacts, and analyses are authenticated by
package-owned, realm-local `WeakSet` and `WeakMap` state. Structured cloning
would produce unauthenticated copies. The backend AST is also retained in a
realm-local weak map and cannot become a cross-realm semantic API.

The distributed dialect builds introduce separate constraints:

- The Node loader uses `node:module` and intentionally rejects any realm with
  `self` or `window`.
- The browser builds are CommonJS/UMD files which a consumer bundler must
  transform.
- Loading a build may write `NodeSQLParser` or `global` on its realm.
- A browser worker can be terminated for a wall-clock deadline, but browsers
  do not expose an enforceable per-worker heap limit.
- One worker per editor would multiply parser memory across marimo's many
  mounted editors.

This decision concerns local browser placement. Node `worker_threads`, native
providers, remote providers, and public packaging are separate decisions.

## Decision

### Browser-first placement

Interactive browser parsing will use a dedicated module worker. The existing
pure-Node inline adapter remains internal evidence and batch-test
infrastructure. It is not a fallback when browser worker construction,
loading, or execution fails.

Browser placement is accepted with an explicit residual risk: input, queue,
response, cache, and lifetime can be bounded, but transient parser allocation
cannot be capped before the browser itself terminates an over-consuming
worker. The current 16 KiB input ceiling remains an upper safety bound, not an
interactive performance claim. Production session wiring remains blocked
until adversarial memory, latency, failure-recovery, and many-editor gates
pass.

### Ownership and scheduling

Each `SqlLanguageService` will lazily own at most one dedicated parser worker.
All sessions opened by that service share it. The worker is neither a
`SharedWorker` nor a module-global singleton.

The first executor is single-lane:

- At most one request is posted at a time.
- The host queue is bounded independently by request count and retained UTF-16
  text units.
- A service owns construction, listeners, timers, termination, and disposal.
- No worker pool or idle shutdown is introduced without profile evidence.
- Service disposal terminates the worker and settles every pending consumer.

Ordinary caller cancellation and supersession settle the consumer promptly
without relying on a worker message that cannot run during synchronous
parsing. The executor may drain and discard that active result. A hard
wall-clock deadline, worker crash, malformed protocol, or service disposal
terminates the generation. The placement benchmark must compare drain versus
restart under rapid edits before the executor policy is frozen.

The execution deadline belongs to the posted worker job, not to any attached
consumer. Consumer cancellation never clears it. A draining operation retains
the active lane until it returns or its generation is terminated; queued work
has a separate wait deadline. Service disposal always terminates immediately.
These rules prevent a cancelled hostile parse from occupying the only worker
indefinitely.

The safety deadline is separate from product latency targets. A deadline
failure never upgrades parser authority and an active request is not
automatically replayed after a crash or timeout.

### Realm and loading boundary

The worker is created with a same-origin URL:

```ts
new Worker(
  new URL("./node-sql-parser-browser-worker.js", import.meta.url),
  { name: "codemirror-sql-parser", type: "module" },
);
```

Blob, data, and evaluated workers are not used. Hosts must allow the emitted
worker URL in their Content Security Policy, normally through
`worker-src 'self'`. The worker asset response also receives a restrictive
policy because a worker has its own execution context.

The constructor shape and its literal options stay static. Current
[Vite worker handling](https://vite.dev/guide/features#web-workers) recognizes
the URL only when `new URL(..., import.meta.url)` appears directly inside the
worker constructor. The
[platform worker contract](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker)
also requires a same-origin entry URL and JavaScript response media type.

The browser worker has a browser-specific loader. It does not weaken or reuse
the pure-Node realm gate. It dynamically imports literal, dialect-specific
paths only:

```text
node-sql-parser/build/postgresql.js
node-sql-parser/build/bigquery.js
```

The worker verifies that `self === globalThis` and that no DOM window exists.
It snapshots and restores the exact `NodeSQLParser` and `global` descriptors
around dialect loading. Cleanup failure poisons that worker generation.

### Private wire protocol

The worker protocol is package-private, versioned, closed, and decoded from
`unknown` on both sides. It transports plain evidence, never authenticated
syntax objects.

The initial request contains only:

- Protocol version
- Host correlation ID
- Grammar ID: PostgreSQL or BigQuery
- Exact untrimmed statement text

DuckDB uses the PostgreSQL grammar. Target-dialect policy stays in the main
realm.

The initial response contains only one closed outcome:

- Parsed normalized statement kind
- Syntax rejection
- Bounded unsupported reason
- Bounded failure code plus retryability

Messages do not contain:

- Public document revisions or session identities
- Parser authorities or dialect handles
- `AbortSignal`, `Error`, stack, or raw backend message values
- Source text echoed in a response
- Absolute document ranges
- Raw ASTs or generic payload bags

The host requires the current protocol version and correlation ID, validates
all keys and closed values, and copies accepted data into new frozen objects.
It then constructs an authentic `SqlParserAnalysis` with the exact pending
request text and the host-owned authority. PostgreSQL and BigQuery rejection
remain uncovered constructs; DuckDB rejection remains compatibility rejection.
Worker isolation does not strengthen the compatibility-only evidence recorded
by ADR 0003.

Old-generation events are ignored by generation-owned listeners. A malformed,
duplicate, unsolicited, or mismatched response kills the generation and
settles the active operation exactly once without exposing raw event data.

### Semantic reuse

Raw backend ASTs will not cross the worker boundary and the first protocol will
not introduce remote AST handles or worker-local AST leases.

Before production session wiring, the worker request will parse once and run
adapter-owned semantic decoders in the same realm. It will return only the
bounded, validated relation facts required by the first completion slice.
This keeps backend shapes private, avoids reparsing once for syntax and again
for relations, and makes cached main-realm evidence measurable.

Worker-local AST caching is deferred until profiling demonstrates that
reparsing is material enough to justify leases, byte accounting, generation
invalidation, and release semantics.

### Packaging boundary

Core and `/vnext` imports must remain SSR-safe and contain no parser grammar or
worker asset. A future optional integration entry may create the worker lazily,
but it will expose an opaque language-service module factory rather than the
protocol, worker URL, transport, pool, or backend AST.

The initial supported bundler claim is limited to packed-consumer fixtures that
run in CI. Source-workspace success is not packaging evidence.

## Evidence required before session wiring

A production-shaped fixture built alongside the exact `npm pack` archive must
prove:

- Core-only import emits no parser or worker bytes.
- PostgreSQL and BigQuery emit separate worker chunks.
- The all-dialect build is absent.
- Worker creation is lazy.
- Both grammars execute in a real browser.
- Main-window parser globals remain unchanged.
- Core import remains SSR-safe.
- A same-origin module worker runs under a strict CSP.
- Worker startup, cold import, warm parse, and message round-trip samples are
  recorded.
- Raw and gzip worker sizes are recorded.

The executor and semantic slices additionally require:

- Main-thread long-task and event-loop responsiveness evidence.
- Malformed message, crash, timeout, late-event, and restart tests.
- Rapid-edit drain-versus-restart measurements.
- One, ten, and fifty editor scenarios.
- Retained worker, listener, timer, and memory checks after disposal.
- Adversarial statements at the accepted input ceiling.

The current product envelopes remain:

- No routine main-thread task over 50 ms.
- Warm active-statement analysis p95 under 16 ms.
- Local completion p95 under 50 ms.

Safety timeouts are not evidence that these product targets are met.

### Initial packed-consumer baseline

The placement harness introduced with this decision builds the exact packed
archive, verifies its core import in an isolated fixture, and separately uses
fixture-owned worker code with the pinned `node-sql-parser` dependency to prove
consumer-side Vite 8 placement feasibility. It serves the production output
with a same-origin CSP and runs it in Chromium.

The worker portion does not yet prove a packed optional parser integration;
that entry does not exist. The protocol PR must move the worker implementation
behind the packed package boundary and remove the fixture's direct parser
dependency before making a public packaging claim.

A representative local Node 24 / Chromium 149 / arm64 macOS sample recorded:

| Output | Raw | gzip |
| --- | ---: | ---: |
| Core-only fixture | 24,056 B | 7,497 B |
| PostgreSQL transitive worker graph | 321,156 B | 67,396 B |
| BigQuery transitive worker graph | 225,309 B | 50,389 B |
| Complete worker fixture | 549,885 B | 118,160 B |

The core module trace contained no `node-sql-parser` module. No dialect
resource loaded before explicit construction. A single static module worker
loaded PostgreSQL and then BigQuery through separate literal lazy imports;
both parsed successfully without changing the main-window parser sentinel.
The per-dialect figures conservatively include their complete static
transitive closures, with shared chunks also reported separately.

One sequential cold/warm run on the shared worker measured:

| Dialect | Grammar load and initialization | First parse | First round trip | Warm parse | Warm round trip |
| --- | ---: | ---: | ---: | ---: | ---: |
| PostgreSQL | 8.0 ms | 2.4 ms | 10.6 ms | 0.1 ms | 0.3 ms |
| BigQuery | 4.2 ms | 2.5 ms | 6.7 ms | 0.2 ms | 0.4 ms |

The worker ready handshake took 10.3 ms in that run.

These numbers establish packaging feasibility and initial size guards. They
are not percentile claims. Stable latency decisions require repeated,
cross-platform samples over the representative and adversarial corpus.

The checked-in harness fails above 68 KiB gzip for the PostgreSQL transitive
graph, 50 KiB for the BigQuery transitive graph, or 120 KiB / 570 KiB for the
complete worker fixture in gzip/raw form. These ceilings include small
measurement headroom and are placement-spike guards, not the final
optional-integration bundle budget.

## Implementation sequence

1. Add this ADR and the packed-consumer browser placement harness.
2. Extract a realm-neutral backend engine and add strict protocol codecs.
3. Add the minimal browser worker and single-lane executor.
4. Add in-worker normalized relation extraction.
5. Add the pure statement coordinator, bounded cache, in-flight sharing, and
   atomic session ownership.
6. Ship relation completion as the first public consuming vertical slice.

Every production step is a medium change and receives two independent,
commit-bound adversarial reviews.

## Consequences

- Synchronous parser CPU work cannot block the editor main thread.
- Fifty editors on one service do not imply fifty parser workers.
- Realm-local authenticity remains an internal safety boundary.
- Worker failure is explicit and never falls back to unsafe inline parsing.
- The raw AST remains replaceable and private.
- A serial worker may create head-of-line blocking; measurement, queue bounds,
  and hard deadlines make that tradeoff visible before considering a pool.
- Browser heap exhaustion cannot be fully contained and remains a documented
  residual risk.
- Browser and Node interactive execution can evolve independently.

## Rejected alternatives

### Run the parser on the browser main thread

Late-result rejection preserves correctness but cannot restore responsiveness
while synchronous parsing runs.

### Clone normalized syntax objects from the worker

Structured cloning loses the package-owned realm authentication required by
the syntax contract.

### Send raw ASTs or AST handles

Raw ASTs expose backend coupling and can be very large. Remote handles add
leases, eviction, crash invalidation, and release semantics before a semantic
consumer exists.

### One worker per editor

This multiplies grammar and runtime memory and conflicts with the many-editor
release target.

### `SharedWorker` or a module-global singleton

Both weaken service ownership and disposal isolation. `SharedWorker` also
narrows runtime and CSP compatibility.

### A generic worker or provider transport

The first need is one parser with a small closed protocol. A general framework
would stabilize abstractions before there is evidence from a second workload.

### A worker pool

A pool increases grammar duplication, memory, scheduling, and cancellation
complexity. It can be reconsidered only if a measured serial bottleneck
outweighs those costs.
