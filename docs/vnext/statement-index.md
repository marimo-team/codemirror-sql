# vNext Statement Index

Status: internal full-scan correctness oracle

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
inferred from a caller-controlled dialect ID. This first oracle owns profiles
for:

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

## Complexity and sequencing

A full build is linear in UTF-16 code units, retains only slot records and a
bounded dollar delimiter, and creates no statement substrings. Point lookup is
logarithmic in slot count. The scanner operates on `analysisText`; the current
length-preserving source transform makes its analysis ranges valid at the same
offsets in `originalText`.

This implementation remains the correctness oracle. Incremental rescanning,
change mapping, cache reuse, and session attachment belong to a later slice and
must be tested against a fresh full build after arbitrary edits.
