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
`originalText` and `analysisText`. A document update creates a new identity
snapshot; a context-only update reuses the same source object. This separation
allows later analysis transforms without making providers depend on editor
state or ambiguous coordinate spaces.

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

At most 10,000 regions and 16 Mi UTF-16 code units are accepted. Masking uses
bounded 64 Ki-code-unit chunks, including for newline-dense input, rather than
a per-code-unit or per-newline array.

The source snapshot, embedded-region model, masking factory, and mapping
functions remain internal. This slice intentionally does not publish a source
transformer or source-map SPI. Generated or reordered source requires a
versioned segment-map design and evidence from real consumers before becoming
public.
