# PR 204 performance CI triage

## What changed

1. Inspected the first failed job and step for run `30194468373`.
2. Read the failing performance assertion before forming a hypothesis.
3. Compared the gate with the capability charter and reproduced it locally.
4. Kept the 1 MiB worst-case scenario, but corrected its budget from 8 ms to
   20 ms.

## Root cause

The new test applied the charter's 8 ms warm 10 KiB bookkeeping target to a
pathological 1 MiB document containing one statement. The GitHub runner
measured 12.85 ms p95; the same case passed locally on faster hardware. The
charter gives the 1 MiB case a responsive-degradation requirement rather than
the 10 KiB numeric target.

The multi-statement 1 MiB gate remains below 8 ms p95. The single-statement
gate now enforces a 20 ms p95 ceiling, and the delayed-provider rapid-typing
gate remains below 500 ms end to end.

## Investigation issues

Local hardware did not reproduce the threshold breach, so the GitHub job log
was required to identify the runner-specific measurement.

## Future improvement

Performance budgets should state their workload size in the test name and use
separate thresholds for normal, degraded, and provider-latency paths.
