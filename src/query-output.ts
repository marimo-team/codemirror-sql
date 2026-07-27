import {
  BoundedSqlLexer,
  type BoundedSqlLexeme,
} from "./bounded-sql-lexer.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import type { SqlSourceSnapshot } from "./source.js";
import type {
  SqlIdentifierComponent,
  SqlTextRange,
} from "./types.js";

export const MAX_QUERY_OUTPUT_COLUMNS = 256;
export const MAX_QUERY_OUTPUT_LENGTH = 65_536;

interface Token extends BoundedSqlLexeme {
  readonly depth: number;
}

export interface SqlQueryOutputColumn {
  readonly definition: SqlTextRange;
  readonly identifier: SqlIdentifierComponent;
  readonly insertText: string;
}

export type SqlQueryOutput =
  | {
      readonly columns: readonly SqlQueryOutputColumn[];
      readonly coverage: "complete" | "partial";
      readonly status: "ready";
    }
  | {
      readonly reason: "resource-limit" | "unsupported-query";
      readonly status: "unavailable";
    };

function punctuation(
  source: SqlSourceSnapshot,
  token: Token | undefined,
  expected: string,
): boolean {
  return token?.kind === "punctuation" &&
    source.analysisText.slice(token.from, token.to) === expected;
}

function word(
  source: SqlSourceSnapshot,
  token: Token | undefined,
): string | null {
  return token?.kind === "word"
    ? source.analysisText.slice(token.from, token.to).toLowerCase()
    : null;
}

function identifier(token: Token | undefined): boolean {
  return token?.kind === "word" ||
    token?.kind === "quoted-identifier";
}

function tokenize(
  source: SqlSourceSnapshot,
  range: SqlTextRange,
  dialect: SqlRelationDialectRuntime,
): readonly Token[] | null {
  const lexer = new BoundedSqlLexer(
    source,
    range.from,
    range.to,
    dialect.querySite.lexicalProfile,
  );
  const tokens: Token[] = [];
  let depth = 0;
  for (let lexeme = lexer.next(); lexeme; lexeme = lexer.next()) {
    if (punctuation(source, { ...lexeme, depth }, ")")) {
      depth = Math.max(0, depth - 1);
    }
    tokens.push(Object.freeze({ ...lexeme, depth }));
    if (punctuation(source, { ...lexeme, depth }, "(")) {
      depth += 1;
    }
  }
  return lexer.resource === null ? Object.freeze(tokens) : null;
}

function decodeColumn(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  token: Token,
): SqlQueryOutputColumn | null {
  const raw = source.analysisText.slice(token.from, token.to);
  const decoded = dialect.querySite.decodeRelationPath(raw, raw.length);
  if (
    decoded.status !== "decoded" ||
    decoded.qualifier.length !== 0 ||
    decoded.prefix.value.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    definition: Object.freeze({ from: token.from, to: token.to }),
    identifier: decoded.prefix,
    insertText: source.originalText.slice(token.from, token.to),
  });
}

function projectionColumn(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  segment: readonly Token[],
  depth: number,
): SqlQueryOutputColumn | null {
  const significant = segment.filter((token) =>
    token.kind !== "comment" && token.kind !== "line-comment"
  );
  if (significant.length === 0) return null;
  for (let index = significant.length - 2; index >= 0; index -= 1) {
    const token = significant[index];
    const alias = significant[index + 1];
    if (
      token?.depth === depth &&
      word(source, token) === "as" &&
      alias?.depth === depth &&
      identifier(alias) &&
      index + 2 === significant.length
    ) {
      return decodeColumn(source, dialect, alias);
    }
  }
  if (significant.some((token) => token.kind === "barrier")) return null;
  const projection = significant.filter((token, index) =>
    !(
      index === 0 &&
      token.depth === depth &&
      (word(source, token) === "all" ||
        word(source, token) === "distinct")
    )
  );
  if (projection.length === 0 || projection.some((token) =>
    token.depth !== depth
  )) {
    return null;
  }
  for (let index = 0; index < projection.length; index += 1) {
    const token = projection[index];
    if (
      index % 2 === 0
        ? !identifier(token)
        : !punctuation(source, token, ".")
    ) {
      return null;
    }
  }
  if (projection.length % 2 === 0) return null;
  const final = projection[projection.length - 1];
  return final ? decodeColumn(source, dialect, final) : null;
}

export function inferSqlQueryOutput(
  source: SqlSourceSnapshot,
  range: SqlTextRange,
  dialect: SqlRelationDialectRuntime,
): SqlQueryOutput {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.from >= range.to ||
    range.to > source.analysisText.length ||
    range.to - range.from > MAX_QUERY_OUTPUT_LENGTH
  ) {
    return Object.freeze({ reason: "resource-limit", status: "unavailable" });
  }
  const tokens = tokenize(source, range, dialect);
  if (tokens === null) {
    return Object.freeze({ reason: "resource-limit", status: "unavailable" });
  }
  const selects = tokens
    .map((token, index) => ({ index, token }))
    .filter(({ token }) => word(source, token) === "select");
  const minimumDepth = Math.min(...selects.map(({ token }) => token.depth));
  const firstTopLevelSet = tokens.findIndex((token) =>
    token.depth === minimumDepth &&
    (
      word(source, token) === "union" ||
      word(source, token) === "intersect" ||
      word(source, token) === "except"
    )
  );
  const precedingArmSelects = firstTopLevelSet < 0
    ? []
    : selects.filter(({ index }) => index < firstTopLevelSet);
  const firstArmDepth = Math.min(
    ...precedingArmSelects.map(({ token }) => token.depth),
  );
  const selected = firstTopLevelSet < 0
    ? selects.find(({ token }) => token.depth === minimumDepth)
    : precedingArmSelects.find(({ token }) =>
        token.depth === firstArmDepth
      );
  if (!selected || !Number.isFinite(minimumDepth)) {
    return Object.freeze({
      reason: "unsupported-query",
      status: "unavailable",
    });
  }
  const projectionDepth = selected.token.depth;
  const segments: Token[][] = [[]];
  let stopped = false;
  let complete = !tokens.some((token) =>
    token.kind === "barrier" || !token.closed
  );
  for (
    let index = selected.index + 1;
    index < tokens.length;
    index += 1
  ) {
    const token = tokens[index]!;
    const tokenWord = word(source, token);
    if (
      (
        token.depth === projectionDepth &&
        tokenWord === "from"
      ) ||
      (
        token.depth <= projectionDepth &&
        (
          tokenWord === "union" ||
          tokenWord === "intersect" ||
          tokenWord === "except"
        )
      )
    ) {
      stopped = true;
      break;
    }
    if (
      token.depth === projectionDepth &&
      punctuation(source, token, ",")
    ) {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1]!.push(token);
  }
  const columns: SqlQueryOutputColumn[] = [];
  complete &&= stopped || segments.some((segment) => segment.length > 0);
  for (const segment of segments) {
    const column = projectionColumn(
      source,
      dialect,
      segment,
      projectionDepth,
    );
    if (column === null) {
      complete = false;
      continue;
    }
    if (columns.length === MAX_QUERY_OUTPUT_COLUMNS) {
      complete = false;
      break;
    }
    columns.push(column);
  }
  return Object.freeze({
    columns: Object.freeze(columns),
    coverage: complete ? "complete" : "partial",
    status: "ready",
  });
}
