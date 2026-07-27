# ADR 0007: Bounded language-feature provider composition

Status: accepted  
Date: 2026-07-27

## Context

Diagnostics, hover, navigation, rename, formatting, symbols, folding, and code
actions need the same revision, coordinate, cancellation, failure-isolation,
and result-validation rules. Leaving those rules to each host creates stale
results, leaked provider errors, unsafe edits, and incompatible native-engine
and language-server integrations.

## Decision

The framework-independent session owns one generic provider composition
runtime. Providers run concurrently under one absolute request deadline and receive
per-provider abort signals. The runtime validates, bounds, freezes, and
normalizes every public result. Collection features compose in configuration
order; scalar features use the first non-empty successful result. Provider ASTs,
errors, transports, and mutable editor objects never cross the boundary.

Statement symbols and folding have a parser-free local baseline. DOM rendering,
debouncing, lint panels, and tooltip presentation remain host policy.

This adds 3,695 gzip bytes (about 3.6 KiB) to the complete
framework-independent core. The measured
artifact is 57,307 gzip bytes and 215,639 raw bytes, so the enforced core
ceilings move from 54 KiB/200 KiB to 57 KiB/212 KiB. Optional parser chunks
remain unchanged and independently chunkable.
The worker-placement page includes the core, so its raw aggregate ceiling moves
from 720 KiB to 725 KiB; its parser chunks do not move, while the aggregate
gzip ceiling moves from 164 KiB to 165 KiB.
The increase is accepted because one shared validator is smaller and safer than
duplicating feature-specific boundaries in every consumer.

## Consequences

- Native engines, LSP clients, host validators, and formatters use one stable
  plain-data contract.
- A slow or failed provider cannot suppress unrelated provider evidence.
- Cancellation and disposal settle without waiting for provider cooperation.
- Synchronous provider time counts against the deadline but cannot be
  preempted; CPU-heavy integrations must run off-thread.
- Core size remains measured in CI with 1,061 gzip bytes and 1,449 raw bytes
  of headroom at acceptance.
