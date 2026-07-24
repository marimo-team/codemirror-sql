# vNext Source Coordinates

Status: experimental core primitive

`SqlTextRange` is the public coordinate primitive:

```ts
interface SqlTextRange {
  readonly from: number;
  readonly to: number;
}
```

Ranges are half-open UTF-16 offsets. Both ends are safe integers and satisfy
`0 <= from <= to <= document.length`. Empty ranges, including the range at EOF,
are valid. `SqlTextChange` extends this shape with `insert` and continues to use
pre-update document coordinates.

The service internally owns an immutable source snapshot with separately named
`originalText` and `analysisText`. A source transaction builds the complete
post-update masked snapshot; a context-only update reuses the same source
object. This separation keeps providers independent of editor state and
ambiguous coordinate spaces.

## Length-preserving masking

The first internal transform masks explicit embedded regions:

- Regions are non-empty, ordered, non-overlapping, and in bounds.
- Region and range inputs are copied into fresh frozen values.
- Each non-CR/LF UTF-16 code unit becomes one space.
- Every CR and LF code unit stays at its exact offset.
- Astral characters therefore become two spaces, while a lone surrogate becomes
  one space.
- `analysisText.length` always equals `originalText.length`, so range mapping is
  identity-preserving while still returning a fresh validated range.

`SqlEmbeddedRegion` is the public document-coordinate input:

```ts
const session = service.openDocument({
  text: "SELECT * FROM {df}",
  context,
  embeddedRegions: [{ from: 14, to: 18, language: "python" }],
});

session.update({
  baseRevision: session.revision,
  document: {
    kind: "changes",
    changes: [{ from: 15, to: 17, insert: "next_df" }],
  },
  embeddedRegions: [{ from: 14, to: 23, language: "python" }],
});
```

The half-open interval covers the complete non-SQL fragment, including its
template delimiters. For marimo, `[14, 18)` masks all of `{df}`; masking only
`df` would leave `{}` to be analyzed as SQL. A document transaction always
supplies the complete region set in coordinates of the resulting text.

At most 10,000 regions and 16 Mi UTF-16 code units are accepted. Masking uses
bounded 64 Ki-code-unit chunks, including for newline-dense input, rather than
a per-code-unit or per-newline array.

The source snapshot, masking factory, and mapping functions remain internal.
Only the document-facing `SqlEmbeddedRegion` input shape is public. This slice
intentionally does not publish a source transformer or source-map SPI.
Generated or reordered source requires a versioned segment-map design and
evidence from real consumers before becoming public.

The internal [statement index](./statement-index.md) scans `analysisText` and
uses its length-preserving offsets without publishing analysis-coordinate
ranges.

Statement-index reuse depends on `analysisText` value and internal lexical
profile identity, not source-object identity. Every accepted source transaction
creates a public revision, while an unchanged text-and-region value may reuse
the immutable source snapshot and index. The index does not retain either the
old or current source text.

Sessions accept complete length-preserving embedded-region sets on open and
source transactions. Original document changes are trusted as analysis changes
only for identity-to-identity updates. A changed masked source invalidates the
cache unless its analysis text is unchanged; it then receives a fresh full
build on demand.
