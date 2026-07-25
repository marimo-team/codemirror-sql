# PR #197 browser CI triage

## Investigation

1. Inspected the failing browser job before forming a hypothesis.
2. Confirmed browser tests and worker builds were not the failing step.
3. Located the first failure in worker-placement bundle verification.
4. Compared the emitted bundle with the checked-in capability charter.

## Root cause

The framework-independent vNext bundle grew from the session walking skeleton
to the completed relation service and catalog scheduler. Its exact packed
consumer output is 40,214 gzip bytes and still contains no parser modules.

The worker-placement script retained the obsolete 16 KiB skeleton limit, while
the capability charter already budgets 75 KiB for core plus the future
CodeMirror adapter.

## Fix

Allocate 48 KiB gzip and 180 KiB raw to the framework-independent core. This
passes the current measured bundle with bounded headroom and reserves 27 KiB of
the declared compressed budget for the separate CodeMirror adapter.

## Friction and future guidance

The local isolated worktree shares dependencies by symlink, so the
worker-placement script cannot perform its nested package-manager install
without replacing that link. Hosted CI remains authoritative for the exact
tarball fixture.

Future vertical slices that change public entry-point reachability should
compare emitted bundle composition with both the per-entry allocation and the
combined 75 KiB capability budget.
