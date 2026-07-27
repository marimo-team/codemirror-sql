# SQL editor completion plan

Status: complete
Updated: 2026-07-27

The standard language-service overhaul is delivered by PR #204. Two additional
vertical PRs finish the remaining product roadmap without coupling CodeMirror
to parser ASTs, database clients, language-server transports, or formatter
implementations.

## PR 1: semantic completion

This PR closes the remaining marimo schema-source cutover blocker and improves
the most common relation sites:

- infer provable CTE and derived-query output names;
- make explicit CTE column lists authoritative;
- use the first set-operation arm for output names;
- complete relations in later set-operation arms;
- complete bounded DML target/source relation sites;
- restrict `JOIN ... USING` completion to shared columns on the immediate
  relation pair;
- preserve explicit partial evidence for stars, unaliased expressions,
  templates, malformed SQL, and resource limits;
- add owned PostgreSQL, BigQuery, and DuckDB completion corpora;
- exercise the behavior through sessions, CodeMirror browser tests, the demo,
  and a warm 10 KiB p95 performance gate.

Local relation names never cross the physical column-provider boundary.
Completion provenance distinguishes inferred query outputs from catalog
columns.

## PR 2: language intelligence and release hardening

Status: complete

The final PR adds the remaining feature methods and provider composition:

- syntax, semantic, and host diagnostics;
- hover;
- definition, references, highlights, and rename;
- document symbols and folding;
- parameter, function, table-function, and snippet contracts;
- formatting and code-action providers;
- bounded native-engine and LSP composition seams;
- deterministic property/fuzz infrastructure and a mutation pilot;
- heap, listener, worker, and multi-editor leak gates;
- Chromium, Firefox, and WebKit evidence;
- public API and bundle regression checks;
- a packed runtime marimo fixture.

Optional DuckDB, language-server, and formatter integrations remain providers.
They augment the fast local baseline and cannot delay or replace unrelated
local evidence.

## Quality gates

Each PR must keep repository and changed-code coverage above 95%, strict type
checking, zero-warning lint, package/SSR/worker placement, browser tests,
security scanning, and explicit latency/bundle budgets green. Exactly two
independent adversarial reviews run only after implementation is complete.
