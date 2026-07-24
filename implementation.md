# SQL Language Service Overhaul: Implementation Plan

Date: 2026-07-24

## Objective

Build the next major version of `@marimo-team/codemirror-sql` as a performant,
robust, correct, and powerful SQL language service with a first-class
CodeMirror adapter.

This is a breaking overhaul. Compatibility with current implementation classes
is not a design constraint. We will still publish a migration guide and use
marimo as the reference consumer.

Success means:

- Correct, explicitly bounded dialect support
- Predictable latency and bounded memory
- Honest partial and unsupported results
- Safety under malformed input, rapid edits, cancellation, and hostile metadata
- A small, understandable public API
- High confidence from independent forms of testing

Before implementation, publish a vNext capability charter defining:

- Initial dialects and constructs
- Explicit non-goals and unsupported syntax
- Browser, Node, bundler, and peer-dependency support
- Latency, memory, and bundle envelopes
- Which features require local, native, or remote providers

## Engineering principles

### Correctness before breadth

Do not claim support until a construct passes its conformance corpus. Explicit
partial results are better than confident incorrect results.

### Simple before clever

Prefer small modules, explicit data flow, pure transformations, and narrow
interfaces. Optimize from profiles. Every abstraction must enforce an
invariant, isolate a dependency, remove duplication, or improve testability.

### Comments explain why

Names, types, and structure should explain normal behavior. Comments should
explain an invariant, external limitation, security boundary, performance
tradeoff, or surprising dialect rule. If ordinary flow needs a long comment,
first simplify the design. Public APIs and non-obvious algorithms still need
useful documentation.

### Types represent the state machine

The goal is not just to compile. Revision identity, source coordinates,
analysis completeness, catalog loading, cancellation, and provider provenance
should be difficult to omit or combine incorrectly.

### Tests provide different evidence

Coverage, contracts, examples, goldens, browser tests, fuzzing, mutation
testing, differential testing, and benchmarks find different failures. No one
metric substitutes for the others.

## Branch and delivery strategy

Create `dev-refactor` as the next-major integration branch. Do not implement
everything directly on it. Use short-lived, focused PR branches:

```text
main
  └─ dev-refactor
       ├─ refactor/analysis-session
       ├─ refactor/source-mapping
       ├─ refactor/statement-index
       ├─ refactor/catalog-provider
       └─ refactor/codemirror-adapter
```

Required practices:

- Every PR into `dev-refactor` leaves it green and runnable.
- Use a merge queue or serialize merges.
- Open a continuous draft PR from `dev-refactor` to `main`.
- Give the branch an owner, a target merge date, and explicit merge/delete
  criteria.
- Allow no direct commits.
- Forward-merge `main` on a fixed cadence and document hotfix propagation.
- Keep a continuously runnable demo and marimo integration fixture.
- Build a canary artifact for every accepted integration commit; publish
  prereleases only at selected checkpoints after canary gates pass.
- Compare API, coverage, bundle, and performance against both `main` and the
  previous `dev-refactor` commit.
- Prefer a sequence of vertical slices to a large rewrite.

The branch is an integration boundary, not permission to accumulate an
unreviewable diff. If its lifetime or divergence becomes excessive, move vNext
development onto `main` behind an unpublished entry point.

Before branch protection is enabled, update CI triggers to include pushes and
pull requests targeting `dev-refactor`; the current workflow targets only
`main`.

## Change sizing and review requirements

Classify every PR before implementation.

### Small

Documentation, test data, mechanical renames, or a local fix with no public,
semantic, concurrency, or performance effect. One normal review is sufficient.

### Medium

Any change to:

- A public/provider interface
- Parsing, source mapping, or semantics
- Scheduling, caching, cancellation, or concurrency
- Catalog resolution
- Completion, diagnostics, hover, navigation, formatting, or gutter behavior
- A dialect rule
- More than one architectural layer

Two independent adversarial reviews are required.

Classification is fail-closed. Sensitive paths, public API diffs, dependency
changes, concurrency modules, and cross-layer changes automatically make a PR
medium or large. A maintainer must approve any downgrade to small.

### Large

A cross-cutting architecture change, new semantic subsystem, or new parser or
remote/native provider. Split it into an ADR and multiple medium PRs. A large
PR is a planning failure unless the change is generated or indivisible.

## Phase 0: establish baselines

Do this before changing production architecture.

### Behavioral baseline

- Capture public exports and generated declarations.
- Record representative completion, hover, navigation, lint, and gutter output.
- Add characterization tests for critical migration-risk behavior.
- Put every confirmed issue from `SQL_EDITOR_RESEARCH.md` in an owned
  traceability backlog. An unfixed case may use a commit-bound known-failure
  fixture with an owner and expiry until its feature slice; the baseline suite
  must not be permanently red.
- Add a marimo fixture for document-level DuckDB validation, connection
  changes, schema completion, many editors, and `{...}` expressions.
- Record demo workflows in browser tests.

Label characterization cases:

```text
preserve    intentional behavior
replace     behavior intentionally changed in the new major
bug         confirmed defect with the desired result documented
unknown     needs a semantic or product decision
```

Characterization tests document behavior; they do not preserve known bugs.

### Performance baseline

Measure fixed document and catalog sizes:

- Cold load and first parse
- Active-statement edit/reparse
- Completion and hover latency
- Full-document diagnostics
- Rapid-edit and stale-result behavior
- Memory after long edit sequences
- 1, 10, and 50 mounted editors
- Bundle and parser chunk sizes

Store JSON results and raw samples as CI artifacts. Establish budgets from
measured baselines and product goals, not arbitrary percentages.

### Quality baseline

Record:

- Line, statement, function, and branch coverage
- Unsafe assertions and suppression directives
- Public API surface
- Bundle size and dependency inventory
- Test runtime and flake rate

Introduce ratchets from this baseline. Do not hide existing problems simply to
make the first gate green.

## Test strategy

### Coverage policy

Targets:

| Metric | Repository | New or changed core code |
| --- | ---: | ---: |
| Lines | At least 95% | At least 95% per changed file |
| Statements | At least 95% | At least 95% per changed file |
| Functions | At least 95% | At least 95% per changed file |
| Branches | 90%, ratcheting to 95% | At least 95% diff coverage |

Branch coverage matters for failure, cancellation, partial-result, and dialect
paths. Coverage exclusions are limited to generated data, type-only code,
debug instrumentation, and true exhaustiveness guards. Each exclusion requires
a reviewed reason.

Coverage is a floor, not an objective. Do not add tests that execute lines
without asserting semantics. Mutation testing must confirm that important
assertions detect meaningful faults.

Enforcement must define:

- All production files as the denominator, including files not imported by
  tests
- Explicit checked-in include/exclude rules
- Repository thresholds for lines, statements, functions, and branches
- Changed executable lines and branches relative to the PR merge base,
  including renamed files
- Diff coverage for lines and branches; statements and functions are enforced
  at the changed-file and risk-tier module level rather than inferred
  unreliably from a textual diff
- Per-module floors for revisions, ranges, source maps, cancellation, and
  provider policy

Add separate failing `test:coverage` and `coverage:diff` commands. Protect
coverage configuration, exclusions, baselines, and generated-code rules with
CODEOWNERS. Baseline reductions or exclusion growth require explicit approval.

Apply strict changed-code gates immediately to vNext modules. The repository
target applies to retained/new-major production code by release candidate; do
not manufacture low-value tests for legacy modules scheduled for deletion.
Named invariant tests and mutation evidence are required for critical logic.
Defensive or platform-specific uncovered code needs a narrow reviewed waiver
with an owner and expiry.

### Unit tests

Use focused, table-driven tests for:

- Range and position primitives
- Identifier normalization and quoting
- Statement boundaries
- Original/rendered source mapping
- Cache identity and invalidation
- Catalog load states and lookup
- Scope and visibility rules
- Provider authority, merge, and ranking policies
- Completion replacement edits
- Cancellation, disposal, and error normalization

### Provider contract tests

Every provider implementation must pass reusable contracts:

- Ranges are absolute UTF-16 half-open ranges inside the document.
- Every request settles, rejects, or is observably aborted.
- Aborted or stale work cannot publish results.
- Results identify revision, provider, authority, and completeness.
- Incomplete catalogs cannot create definite unknown-object diagnostics.
- Document validators are never invoked once per statement.
- `dispose()` prevents callbacks and editor dispatch.
- Provider errors degrade according to documented policy.

### Golden semantic corpus

Use structured, reviewed fixtures for:

- Nested and correlated subqueries
- CTE ordering, recursion, and shadowing
- Derived relations and `LATERAL`
- Set operations
- Clause-specific alias visibility
- Qualified, unqualified, and ambiguous references
- Search paths and multiple catalogs
- Quoted identifiers and case folding
- Incomplete input at likely cursor positions
- DML and templates/interpolation

Each fixture names its dialect and expected capability. Prefer typed structured
outputs to large parser-AST or DOM snapshots.

### Snapshot tests

Use snapshots only for stable, high-dimensional normalized results such as a
scope graph or complete feature response. Prefer direct assertions for simple
behavior. Never snapshot parser-specific ASTs, unstable ordering, incidental
error details, or entire DOM trees. CI must not auto-update snapshots.

### Property and fuzz tests

Test invariants:

- Statement ranges remain ordered, non-overlapping, and in bounds.
- Template masking preserves length and newline positions.
- Source-map conversion always yields valid ranges.
- Arbitrary edit sequences never publish stale results.
- Completion edits remain inside the document.
- Identifier quote/normalize behavior round-trips where defined.
- Caches stay bounded.
- Arbitrary input terminates within resource budgets.

Run a deterministic short suite on every PR and longer randomized campaigns
nightly. Commit a minimal regression fixture and seed for every failure.

Execute parser fuzz cases in disposable workers or processes. A normal Vitest
timeout cannot interrupt synchronous code that blocks the event loop. The
parent enforces wall-clock and memory limits and records the seed, input,
dialect, dependency versions, and operation sequence. Distinguish crash,
timeout, OOM, invalid range, unhandled rejection, and stale publication.

### Differential tests

Compare supported constructs with:

- SQLGlot for scope and qualification
- DuckDB for DuckDB parsing and selected catalog behavior
- `node-sql-parser` location output while it is a backend
- `sqruff` if used for formatting or linting

Classify differences as `ours-bug`, `upstream-difference`,
`dialect-ambiguity`, `unsupported`, or `intentional-policy`. Another tool is
evidence, not automatically the oracle.

### Integration tests

Use deterministic fake providers and schedulers to test:

- Edit → invalidate affected layers → publish current feature result
- Dialect/connection changes without text edits
- Catalog refresh without reparsing
- Remote validation cancellation during rapid typing
- Local/native completion composition
- Disposal with work in flight
- Provider timeout and worker crash recovery
- Partial catalogs

Use fake clocks; do not base correctness assertions on real time.

Inject failures including malformed payloads, repeated callbacks, callback
after abort/dispose, synchronous throws before Promise creation, rejection
after abort, worker restart, catalog refresh storms, duplicate IDs,
out-of-order results, and exceptions from consumer renderers.

### Browser and end-to-end tests

Vitest currently includes a Playwright browser project through the aggregate
test configuration, but the documented `test:browser` script references the
nonexistent `vitest.browser.config.ts`. Repair that script and give the browser
project a named required CI step so configuration changes cannot silently stop
running it.

Cover:

- Completion opening, filtering, refreshing, and applying the exact edit
- Safe, attributed hover rendering
- Diagnostic movement and removal after edits
- Current-statement gutter and navigation
- Dialect/connection changes without text edits
- Stale slow-provider rejection
- Keyboard and accessibility behavior

Require Chromium on PRs. Run Firefox and WebKit nightly until sufficiently
stable and fast. Capture traces and screenshots on failure, not as a broad
pixel-snapshot suite.

### Consumer and packaging tests

Maintain a small marimo fixture here and a pinned cross-repository test in
marimo. Cover dynamic context, document validation, many SQL cells, `{...}`
regions, external completion composition, partial/nested catalogs, and custom
renderers.

Test a packed tarball rather than workspace source. For release candidates:

- Install it in a minimal CodeMirror consumer.
- Import every documented entry point.
- Build with supported bundlers.
- Run in a real browser and in the marimo fixture.
- Verify ESM, declarations, source maps, peer dependencies, and optional
  providers.
- Verify core-only consumers do not bundle optional integrations.

### Security tests

Test hostile catalog metadata, LSP Markdown/HTML, deeply nested SQL, extremely
long identifiers/statements, invalid/cyclic provider data, worker crashes, and
pathological regular-expression input. CodeQL and dependency scanning remain
required but are not substitutes for behavior tests.

### Mutation testing

Run mutation tests on ranges, semantics, scheduling, caching, and provider
policy. Start nightly. Establish a baseline mutation score, narrowly classify
equivalent mutations, and ratchet upward. High coverage with a weak mutation
score blocks further work in that subsystem.

Track mutation results per critical module and mutation class. Designated
revision, range, source-map, cancellation, and security modules may have no
surviving high-risk mutants. Equivalent-mutant exclusions require a reviewed
reason and expiry.

### Invariant traceability and suite integrity

Maintain a checked-in invariant registry with stable ID, owner, failure mode,
affected modules, required test layers, test references, and applicable
performance/security budget. CI fails if an invariant loses all mapped tests.

Fail CI on:

- Zero discovered tests in an expected suite
- Unexpected `.only`, skipped, or todo tests
- Stale snapshots
- Unhandled rejections
- Leaked timers, handles, workers, listeners, or DOM nodes
- Unexpected browser console errors
- Missing fixture provenance

Print test counts, duration, retry count, and first-attempt failures by category.
Retry success must not silently erase a flake; quarantines require an owner and
deadline.

### Performance tests

Report median, p95, worst observed time, and memory where measurable. Separate:

- Pure core microbenchmarks
- Edit-to-result scenario benchmarks
- Browser/CodeMirror benchmarks
- Bundle-size checks

Exercise 1/10/100/1,000 statements, small/large/partial catalogs, cold/warm
completion, 1/10/50 editors, rapid edits with delayed providers, and
template-heavy documents.

PR CI runs stable smoke benchmarks and fails only on meaningful regressions
beyond agreed budgets. Full performance and leak tests run nightly on
controlled runners. Store history to catch gradual degradation.

For every blocking benchmark, define runner class, warmups, sample count,
interleaved base/head execution, outlier policy, confidence method, minimum
effect size, absolute ceiling, and an inconclusive result for excessive noise.
Record hardware and runtime metadata. Use controlled runners for blocking
latency and memory gates; hosted runners enforce only gross smoke ceilings and
bundle size. Gate tail latency under load and event-loop blocking. Do not use
“worst observed” as a statistical gate; use a defined percentile plus a hard
timeout.

Memory tests run in isolated processes with fixed edit/mount cycles and explicit
GC where supported. Track heap, DOM/listener retention, worker lifecycle, cache
size, process RSS, and retained-memory slope separately.

## Type-safety standard

The repo already enables `strict`, `noUncheckedIndexedAccess`, and
`noUnusedLocals`. Keep these and evaluate:

- `exactOptionalPropertyTypes`
- `noImplicitOverride`
- `noPropertyAccessFromIndexSignature`
- `verbatimModuleSyntax`

New-major rules:

- No explicit `any`.
- No double assertion such as `as unknown as T`.
- No unchecked casts of parser, provider, JSON, or network data.
- No `@ts-ignore`.
- `@ts-expect-error` only in type tests, with the expected reason.
- Use `unknown` at boundaries and narrow or decode it.
- Use discriminated unions for partial, recovered, failed, and cancelled states.
- Use opaque types where document/revision/range identity can be confused.
- Use exhaustive checks for closed unions.
- Prefer `satisfies`; allow useful safe constructs such as `as const`.

External ASTs are untrusted boundary data. Decode them in one adapter. Feature
code must not scatter parser-specific assertions.

Automate this with type-aware lint rules, a forbidden-pattern CI check, type
tests, declaration generation, and a public API diff. If a third-party type
forces a narrow assertion, isolate and runtime-check it in an adapter and
require adversarial review; do not weaken global settings.

The current production `tsconfig.json` excludes tests and the demo. Add separate
typecheck projects for production, unit tests, browser tests, demo, fixtures,
and public type tests. Validate emitted declarations in a clean consumer with
`skipLibCheck: false`.

Forbidden assertions apply strictly to production. Tests use typed builders
rather than double assertions, but may have a separately audited boundary
registry for unavoidable third-party mocks. Decide each proposed compiler
option in an early ADR; do not leave “evaluate” as a permanent gate.

## Code-quality standard

Enforce the dependency direction:

```text
core primitives
  ← document/source mapping
  ← syntax/statement analysis
  ← semantic model
  ← catalog and feature policies
  ← providers
  ← CodeMirror adapter
```

Core cannot import CodeMirror, DOM, remote providers, or parser-specific ASTs.
Automate import-boundary and dependency-cycle checks.

Set ratcheted review thresholds for complexity, function/file size, nesting,
and parameter count. These are review triggers, not an invitation to split one
bad function into many bad functions.

Public API rules:

- Keep the stable surface small.
- Do not export implementation classes for tests.
- Prefer interfaces and factories over subclassing.
- Mark experimental surfaces explicitly.
- Generate and review an API report.
- Require examples and release notes for public behavior changes.

Every runtime dependency needs bundle, license, security, maintenance, and
alternatives review, and must remain optional where appropriate.

## Two-reviewer adversarial loop

Every medium change receives two independent reviews before dependent work
continues.

### Reviewer A: correctness and safety

Review SQL semantics, Unicode/ranges, partial-result confidence, concurrency,
cancellation, disposal, security boundaries, and missing negative/fuzz tests.

### Reviewer B: performance and design

Review parsing/allocation cost, cache identity, bounded memory, main-thread
work, layer coupling, public API leakage, excessive abstraction, and benchmark
evidence.

Both receive the same diff, acceptance criteria, invariants, test results, API
diff, and benchmark/bundle deltas. They do not see each other's initial
conclusions.

Loop:

1. Implement the scoped change and evidence.
2. Run automated gates.
3. Obtain both reviews.
4. Classify findings as blocking correctness, architecture, performance, test
   gap, documentation gap, justified follow-up, or rejected with evidence.
5. Resolve all blocking findings.
6. Rerun gates. Each reviewer rechecks unresolved findings and materially
   changed areas against the new commit.
7. Require two full reviews again only when the revision changes public
   contracts, architecture, concurrency, or benchmark behavior materially.
8. After two automated resolution cycles, escalate disputes to a human
   maintainer rather than looping indefinitely.
9. Store reports and the resolution ledger in the PR.

Reviews must be tied to the exact commit; a push invalidates prior attestations.
Review agents supplement human maintainers and never authorize a merge.
Prefer reviewers with different prompts or models; two identical agents are
correlated evidence. Independent downstream work may target an accepted
interface contract, but cannot merge until its dependency is accepted.

### Review automation

Generate one review packet containing:

- Base/head commit and diff
- Changed files and risk classification
- Affected invariants and ADRs
- Test/coverage results
- API, benchmark, and bundle deltas

Add a PR template for change size, risks, evidence, two reports, finding ledger,
and rollback/disable strategy. CI should reject a medium PR missing commit-bound
review attestations or containing unresolved blockers.

Use independent bot/App identities to create required GitHub checks containing
reviewer identity, model/version, packet digest, head SHA, findings, and
disposition. Validate them through a protected reusable workflow from the base
branch so a PR cannot approve itself. Maintainers approve classification
overrides and rejected blocking findings.

Request GitHub Copilot review exactly once on every medium or large PR, after
the PR has a coherent head that is ready for review:

```bash
gh pr edit <number> --add-reviewer @copilot
```

Copilot is an additional advisory review, not one of the two independent
commit-bound adversarial attestations and not a substitute for human approval.
Resolve or explicitly disposition its actionable comments in the finding
ledger. Do not re-request Copilot after later pushes or material rewrites; the
commit-bound adversarial reviewers and required CI provide exact-head
revalidation.

## CI architecture

### Required fast PR lane

Set measured per-job budgets and run independent jobs in parallel. Aim for a
useful result within ten minutes without making that aspirational number a
correctness constraint:

- Frozen install
- Non-mutating lint
- Strict typecheck and forbidden-practice scan
- Unit, contract, and deterministic short fuzz tests
- Coverage and changed-code coverage
- Build, declarations, and public API diff
- Packed-package validation
- Bundle-size budget
- Required Chromium integration
- Import boundaries and dependency cycles

Cancel superseded runs.

Add a CI self-test before branch protection: deliberately failing fixture PRs
must prove every required check appears and blocks merging.

### Required affected integration lane

For relevant paths, run full browser tests, marimo fixture, packed consumers,
performance smoke tests, and security fixtures. Core, package, TypeScript,
lockfile, or CI changes conservatively run everything.

### Nightly lane

Run randomized fuzzing, mutation tests, the full performance matrix,
memory/leak scenarios, Firefox/WebKit, dependency auditing, differential
testing, and the dialect conformance matrix.

Nightly failures should open or update a tracking issue with seeds and
artifacts. Avoid duplicate issue spam. Maintain a scheduled-health check that
records suite, source SHA, configuration digest, completion time, and expiry.
Release candidates are blocked by red or stale scheduled health. Define an
owner, triage SLA, and maximum quarantine duration.

Run reduced mutation, differential, and leak sentinels in PR CI when critical
modules change; nightly evidence alone is too delayed.

### Release-candidate lane

Run all scheduled-class suites against the exact tagged SHA.

Build one `npm pack` artifact from that SHA in a reusable verification workflow
and record its SHA-256 and provenance. Split release evidence:

- Source/configuration gates against the exact tagged SHA: unit, coverage,
  mutation, fuzz, static analysis, API, source-level benchmarks, and dependency
  inventory
- Packaging/runtime gates against the exact tarball: minimal consumers,
  supported bundlers/peers, browser smoke tests, marimo, declarations, source
  maps, bundle composition, and migration examples

Publishing downloads that immutable artifact and requires successful release
checks and scheduled-class evidence for the tagged SHA. Protect the npm
environment and reject tags not reachable from the protected release branch.
Never rebuild different bits in the publish job.

Checkpoint prereleases publish the verified canary artifact under a `next`
dist-tag with provenance after their defined subset of source and runtime gates.
Document their versioning and retention policy; ordinary integration commits
remain downloadable CI artifacts rather than permanent npm versions.

### Supported-runtime matrix

Choose explicit supported Node, browser, peer-dependency, bundler, and SSR
versions. Test minimum and latest Node and peer sets against the tarball. Narrow
`engines` and compatibility claims to what CI continuously validates.

## Ratchets

- Coverage cannot decrease for retained/new-major code and reaches the
  repository target by release candidate; changed-code and invariant floors
  apply immediately.
- No new unsafe type practice is allowed from the first overhaul commit.
- Existing unsafe practices decrease by milestone.
- Bundle/performance budgets cannot regress without explicit approval.
- Mutation score cannot decrease.
- Flaky tests need an owner and expiry; quarantine is temporary.
- Public API growth requires explicit approval.

Ratchets prevent new debt immediately while allowing deliberate removal of
existing debt.

## Definition of done for a medium change

- Acceptance criteria and affected invariants are satisfied.
- Relevant unit, contract, integration, browser, fuzz, and failure tests pass.
- Changed core code meets coverage targets.
- No forbidden type practice is introduced.
- Lint, typecheck, build, package, and API checks pass.
- Performance and bundle budgets pass or their change is approved.
- Fuzz failures have permanent regression fixtures.
- Both independent reviews have no unresolved blocking findings.
- Docs, ADRs, examples, and capability matrices are current.
- The result is simpler or demonstrably more capable than what it replaces.

## Implementation sequence

### 1. Governance and baseline

Deliver branch protection, PR/ADR templates, review automation, behavior/API/
coverage/bundle/performance baselines, confirmed-bug tests, and the marimo
fixture.

Exit when every baseline is reproducible in CI.

### 2. Quality harness and walking skeleton

Deliver enforced coverage, contract/golden organization, fuzz/property harness,
mutation pilot, explicit browser CI, package smoke tests, type/import/API
checks, and benchmark/bundle budgets.

In parallel, build a deliberately thin walking skeleton:

```text
document revision
  → parser adapter
  → minimal normalized result
  → one completion result
  → CodeMirror presentation
```

Apply final changed-code gates to this new code immediately. Do not delay
architectural feedback while exhaustively testing legacy code scheduled for
deletion.

Exit when critical characterization exists, harnesses are reproducible, and CI
catches deliberately introduced stale-result, unsafe-cast, range, bundle, and
API defects. Repository-wide coverage of retained/new-major code reaches the
target by release candidate, not as a waterfall prerequisite.

### 3. Core primitives and minimal provider contracts

Deliver revisions, UTF-16 half-open ranges, original/rendered source maps,
embedded regions, statement boundaries, disposable sessions, in-flight
deduplication, and bounded caches.

Also define the minimum parser, validator, catalog, completion, and provider
result contracts now, including capability, authority, load state,
document-versus-statement granularity, timeout, cancellation, and provenance.
Run early DuckDB, LSP, formatter, and worker feasibility spikes and record
go/no-go ADRs. These contracts cannot be deferred until after features that
depend on them.

Exit when arbitrary edit properties pass, stale results cannot apply, and
unchanged statements are reused.

### 4. Parser integration and completion slices

Deliver the parser contract, measured `node-sql-parser` adapter, normalized
artifacts, isolated execution, bounded coordination, and authenticated syntax
evidence.

Deliver relation completion independently through a bounded partial-`SELECT`
query-site recognizer and CTE-visibility recognizer plus one asynchronous,
coverage-aware catalog provider. The host may implement that provider as a
composite; multi-provider arbitration remains a later explicit design.
This path must remain useful for incomplete SQL and must not construct or wait
for the parser worker.

Keep the public provider and completion types provisional until the vertical
slice, two provider shapes, packed marimo integration, hostile decoding and
lifecycle suites, and declaration snapshots pass.

Then design query blocks, typed visibility, CTE/relation/alias/column bindings,
and explicit partial semantic states against materially different dialect
corpora before an additional parser-derived scope feature consumes them. The
bounded CTE recognizer remains the explicit narrow exception. Flat parser
relation lists are not a semantic model.

Exit when relation completion works through the framework-independent session,
catalog and parser failures remain independent, semantic goldens pass, parser
ASTs do not leak, and dialect differences are classified.

### 5. Feature vertical slices

After completion proves the end-to-end model, migrate:

1. Statement selection and gutter
2. Syntax diagnostics
3. Hover
4. Navigation
5. Semantic diagnostics

Each slice includes CodeMirror integration, browser tests, performance evidence,
and the two-reviewer loop. Delete the old slice after acceptance.

### 6. Catalog and provider expansion

Expand the minimal contracts into lazy catalogs, stable
identities/invalidation, production feature-specific authority, native/remote
providers, and the recorded DuckDB/LSP/`sqruff` decisions.

Exit when optional remote work never delays the local baseline beyond the
checked product response budget, incomplete local results remain useful, and
all race/failure/partial-catalog contracts pass.

### 7. Marimo migration and release

Migrate marimo, publish performance results and a dialect capability matrix,
resolve prerelease feedback, remove legacy exports, and finalize migration/API
documentation.

Exit when the exact release tarball passes marimo and minimal-consumer smoke
tests plus all correctness, quality, security, performance, and review gates.

## Initial automation backlog

Before semantic implementation:

1. Add `dev-refactor` CI triggers and prove required checks fail closed.
2. Enforce explicit all-file Vitest coverage and per-file changed-code coverage.
3. Add explicit Chromium browser script and required CI step.
4. Add production/test/demo/fixture/public-consumer typecheck projects.
5. Add package tarball, peer-version, bundler, and minimal-consumer tests.
6. Add API declaration diffing.
7. Add bundle reporting and budgets.
8. Add isolated deterministic property/fuzz infrastructure.
9. Add JSON benchmarks, base/head comparison, and noise policy.
10. Add the hermetic marimo fixture and pinned scheduled canary.
11. Add forbidden type-practice, import-boundary, and cycle checks.
12. Add the invariant registry and test-suite integrity checks.
13. Add PR risk template and review-packet generation.
14. Add protected, commit-bound two-reviewer checks.
15. Automate one GitHub Copilot review request per medium or large PR.
16. Add verified-artifact provenance to release CI.
17. Add nightly mutation, fuzz, cross-browser, leak, and performance workflows.
18. Add expiring scheduled-health and deduplicated failure issues.
19. Define the supported runtime and dependency matrix.

## Final recommendation

The proposed emphasis on tests, >95% coverage, type safety, simplicity, and
adversarial review is right. The important refinements are:

- Use coverage as a ratcheted floor, backed by branch coverage, mutation tests,
  and semantic corpora so the metric cannot be gamed.
- Establish behavior and performance baselines before replacing code.
- Keep `dev-refactor` green with small vertical PRs.
- Test revisions, provider contracts, partial results, cancellation, and
  disposal as aggressively as happy-path SQL.
- Make marimo a continuous reference consumer.
- Tie reviews to exact commits and repeat them after changes.
- Gate latency, memory, bundle size, API growth, and correctness with measurable
  budgets.

Automation should make the demanding path the easiest path while keeping every
change small enough for humans and review agents to understand completely.
