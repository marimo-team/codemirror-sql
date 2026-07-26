# PR #204 CodeQL CI triage

## Failure

- Check: CodeQL
- Run: `89773750413`
- Severity: high
- Rule: incomplete string escaping or encoding
- Location: `demo/index.ts`, `loadExample`

## Root cause

The demo encoded the requested cursor position with a single `|` marker and
removed it with `String.prototype.replace`. CodeQL correctly noted that this
form removes only the first occurrence, leaving ambiguous behavior for input
containing more than one pipe.

## Resolution

The helper now finds the cursor marker once and removes that exact character
with indexed slices. Inputs without a marker are left unchanged. This makes the
single-marker contract explicit and avoids a partial replacement operation.

## Verification

The correction passed:

- lint and all TypeScript configurations;
- 1,703 unit tests;
- 3 dedicated performance gates;
- 17 browser tests;
- coverage at 97.63% statements, 96.35% branches, 99.62% functions, and
  97.83% lines;
- demo and packed-package builds;
- package smoke, test-integrity, and worker-placement checks.

During verification, running unit and performance tests concurrently also
revealed that the timing-sensitive performance suite was included in the
ordinary unit suite. It now has a dedicated Vitest configuration and is
excluded from normal and coverage runs, preventing unrelated host contention
from making functional CI flaky while preserving the explicit performance
gate.
