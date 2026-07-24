# vNext Statement Index

Status: internal full-scan oracle with incremental session reuse

The statement index is a synchronous, parser-free partition of
`analysisText`. It does not classify, parse, validate, or copy statements, and
it has no public `/vnext` export yet.

Each exact slot contains:

- An `extent` that participates in a contiguous partition of the complete text.
- A `source` range that includes leading and trailing trivia but excludes the
  terminator.
- An optional one-code-unit `terminator`, owned by the slot on its left.
- `hasCode`, which distinguishes code from whitespace/comment-only slots.
- A lexical end state for incomplete quoted strings or block comments.

An empty document has one empty slot. A document ending exactly in a semicolon
has an explicit trailing empty slot; trailing trivia instead forms the final
trivia-only slot. Consecutive semicolons retain their empty slots.

The scanner returns an opaque suffix instead of guessed boundaries when it
encounters an unsupported custom delimiter, an unsupported BigQuery procedural
body, or a resource limit. Opaque slots omit `source`, `terminator`, and
`hasCode`, so later layers cannot accidentally parse them as exact statements.
At most 10,000 slots are materialized; a semicolon-dense remainder collapses
into one opaque slot.

## Cursor affinity

Point lookup always requires `left` or `right` affinity. At a shared extent
boundary, left selects the preceding slot and right selects the following slot.
At position zero both select the first slot. At EOF after a terminator, left
selects the terminated slot and right selects the explicit trailing empty slot.
At EOF in an unterminated final statement, both select that statement.

The lookup uses binary search. It deliberately does not implement a hidden
"nearest code statement" fallback; completion, hover, gutter, and future
run-current-statement commands need different policies.

## Dialect profiles

Lexical behavior is carried by immutable internal profile identity. It is never
inferred from a caller-controlled dialect ID. Frozen built-in dialect
singletons select package-owned profiles through private runtime metadata. This
first oracle owns profiles for:

- PostgreSQL: doubled quotes, `E'...'`, dollar-quoted strings, and nested block
  comments, following the
  [PostgreSQL lexical contract](https://www.postgresql.org/docs/current/sql-syntax-lexical.html).
  Dollar-tag and literal-prefix boundaries conservatively treat every
  non-ASCII code point as identifier-like, covering the engines' permissive
  Unicode behavior without exposing internal semicolons. SQL routine bodies
  introduced by `BEGIN ATOMIC` are opaque in this slice.
- DuckDB: doubled quotes, escape strings, tagged dollar-quoted strings, and
  nested comments. Dollar quoting follows
  [DuckDB literal types](https://duckdb.org/docs/current/sql/data_types/literal_types).
- BigQuery: single, double, triple, raw, bytes, and raw-bytes strings; backtick
  identifiers; `#` comments; and non-nesting block comments, following the
  [GoogleSQL lexical contract](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/lexical).
  Procedural bodies, including labeled loops, are opaque in this slice.
- Dremio: a compatibility profile limited to verified single-quoted strings,
  double-quoted identifiers, and standard comments. It does not silently
  inherit PostgreSQL extensions.

Unterminated lexical constructs consume the remainder and report their opening
offset. Regular BigQuery strings also fail closed at a line break, because only
triple-quoted strings may span lines.

## Incremental updates

The full build remains the correctness oracle. When a session already has an
index and receives trusted ordered changes in analysis coordinates, the
incremental path restarts conservatively at the beginning of the old slot at or
to the left of the earliest change. Slot starts are safe checkpoints because
lexical and prefix state is normal there.

Scanning continues until an exact terminated boundary maps to the start of an
unchanged old suffix after the final change. The unchanged prefix is retained;
the suffix is reused directly when its offset is unchanged or copied with
shifted frozen ranges when the net edit length changes. Convergence is rejected
if the combined result would violate the slot limit or make a prior
resource-limit suffix unsafe to reuse.

Inconsistent change metadata falls back to a fresh full build. If no safe
boundary converges, scanning continues through EOF. Unsupported procedural or
custom-delimiter syntax and resource limits remain scanner-produced opaque
suffixes; the incremental layer never guesses a boundary or creates a new
opacity reason.

## Session cache and complexity

The index cache is private, lazy, and per session. It retains only the current
index, document sequence, and lexical-profile identity, not source text or
history. Context-only updates reuse it for the same profile. Equal analysis
text reuses it across a new document revision. Trusted identity-source changes
update it incrementally; changed replacements, profile changes, and transformed
sources without trusted analysis-coordinate changes invalidate it. Disposal
clears it.

A full build is linear in UTF-16 code units, retains only slot records and a
bounded dollar delimiter, and creates no statement substrings. Point lookup is
logarithmic in slot count. The scanner operates on `analysisText`; the current
length-preserving source transform makes its analysis ranges valid at the same
offsets in `originalText`.

Incremental work is proportional to the rescanned region plus any shifted
suffix records, with a worst case equal to a full linear scan. Randomized edit
tests compare every incremental result with a fresh oracle build.

`pnpm run bench:statement-index` measures full and incremental paths on a
roughly 1 MiB, 1,000-statement document, including a local middle edit and a
prefix insertion that shifts the reusable suffix. It also measures recovery
from a resource-limited 10,000-slot index to guard the linear convergence path.
