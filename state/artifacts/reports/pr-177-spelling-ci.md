# PR #177 spelling CI regression

## Root cause

The adapter rejection tests used a misspelled SQL keyword as deliberately
invalid SQL. The repository spelling check correctly flagged it even though it
was test data.

## Resolution

The fixtures now use the correctly spelled but syntactically invalid
`SELECT FROM`. This preserves the rejection-path coverage without broadening
the spelling allowlist.

## Verification

- Focused node-sql-parser adapter tests
- vNext test typecheck
- Lint and repository integrity checks
- `git diff --check`

## Follow-up

Prefer malformed grammar over misspelled keywords for parser rejection
fixtures unless a spelling error is itself the behavior under test.
