# PR #197 browser CI triage

## Investigation

1. Inspected the failing browser job before forming a hypothesis.
2. Confirmed browser tests and worker builds were not the failing step.
3. Located the first failure in worker-placement bundle verification.
4. Compared the emitted bundle with the checked-in capability charter.

## Root cause

The framework-independent vNext bundle grew from the session walking skeleton
to the completed relation service and catalog scheduler. The exact local
packed-consumer measurement is 40,121 gzip/143,265 raw bytes; hosted Linux CI
measured 40,214 gzip bytes. It still contains no parser modules.

The worker-placement script retained the obsolete 16 KiB skeleton limit, while
the capability charter already budgets 75 KiB for core plus the future
CodeMirror adapter. The complete worker fixture also embeds the page-side core,
so after the first correction its obsolete aggregate ceiling failed at 150,847
gzip bytes. The exact local aggregate is 150,985 gzip/669,106 raw bytes; its
PostgreSQL and BigQuery lazy grammar closures are unchanged.

## Fix

Allocate 48 KiB gzip and 180 KiB raw to the framework-independent core. This
passes the current measured bundle with bounded headroom and reserves 27 KiB of
the declared compressed budget for the separate CodeMirror adapter.

Allocate 160 KiB gzip and 700 KiB raw to the complete worker evidence fixture.
This is an aggregate test-fixture ceiling, not a product bundle promise: it
includes the page-side core plus both lazy parser grammars. The dedicated
dialect-closure ceilings remain unchanged and continue to detect parser growth.

## Friction and future guidance

The local isolated worktree shares dependencies by symlink, so its root install
must run with CI semantics to avoid an interactive module-directory prompt.
Hosted CI remains authoritative for platform-sensitive compressed sizes; the
local exact-tarball report records the raw sizes and dependency graph.

Future vertical slices that change public entry-point reachability should
compare emitted bundle composition with both the per-entry allocation and the
combined 75 KiB capability budget.
