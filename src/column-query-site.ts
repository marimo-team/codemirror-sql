import {
  BoundedSqlLexer,
  type BoundedSqlLexeme,
} from "./bounded-sql-lexer.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import { isSqlRelationDialectRuntime } from "./relation-runtime-auth.js";
import {
  isSqlSourceSnapshot,
  type SqlSourceSnapshot,
} from "./source.js";
import {
  isSqlStatementSlotSnapshot,
  type SqlStatementSlot,
} from "./statement-index.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlTextRange,
} from "./types.js";
import {
  MAX_QUERY_OUTPUT_COLUMNS,
  type SqlQueryOutput,
  type SqlQueryOutputColumn,
} from "./query-output.js";

export const MAX_COLUMN_QUERY_RELATIONS = 256;

export interface SqlColumnQueryRelation {
  readonly alias: SqlIdentifierComponent | null;
  readonly columnAliases?: {
    readonly columns: readonly SqlQueryOutputColumn[];
    readonly coverage: "complete" | "partial";
  };
  readonly local?: {
    readonly kind: "cte" | "derived";
    readonly output?: SqlQueryOutput;
    readonly queryRange: SqlTextRange;
  };
  readonly path: SqlIdentifierPath;
  readonly range: SqlTextRange;
}

function parseColumnAliases(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  tokens: readonly Token[],
  start: number,
  depth: number,
): {
  readonly aliases:
    | SqlColumnQueryRelation["columnAliases"]
    | undefined;
  readonly next: number;
} {
  const open = tokens[start];
  if (!punctuation(source, open, "(") || open?.depth !== depth) {
    return { aliases: undefined, next: start };
  }
  const columns: SqlQueryOutputColumn[] = [];
  let expectIdentifier = true;
  let coverage: "complete" | "partial" = "complete";
  let index = start + 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (
      token.kind === "comment" ||
      token.kind === "line-comment"
    ) {
      continue;
    }
    if (punctuation(source, token, ")") && token.depth === depth) {
      if (expectIdentifier) coverage = "partial";
      return {
        aliases: Object.freeze({
          columns: Object.freeze(columns),
          coverage,
        }),
        next: index + 1,
      };
    }
    if (token.depth !== depth + 1) {
      coverage = "partial";
      continue;
    }
    if (expectIdentifier && isIdentifier(token)) {
      const path = decodePath(
        source,
        dialect,
        token.from,
        token.to,
      );
      const identifier = path?.length === 1 ? path[0] : undefined;
      if (!identifier) {
        coverage = "partial";
      } else if (columns.length < MAX_QUERY_OUTPUT_COLUMNS) {
        columns.push(Object.freeze({
          definition: Object.freeze({
            from: token.from,
            to: token.to,
          }),
          identifier,
          insertText: source.originalText.slice(token.from, token.to),
        }));
      } else {
        coverage = "partial";
      }
      expectIdentifier = false;
      continue;
    }
    if (
      !expectIdentifier &&
      punctuation(source, token, ",")
    ) {
      expectIdentifier = true;
      continue;
    }
    coverage = "partial";
  }
  return {
    aliases: Object.freeze({
      columns: Object.freeze(columns),
      coverage: "partial",
    }),
    next: index,
  };
}

export type SqlColumnQuerySiteIssue =
  | "derived-relation"
  | "incomplete-relation"
  | "local-output-partial"
  | "nested-query"
  | "opaque-template-context"
  | "table-function";

export type SqlColumnQuerySiteResult =
  | {
      readonly status: "inactive";
      readonly reason:
        | "cursor-in-comment"
        | "cursor-in-string"
        | "cursor-in-embedded-region"
        | "not-column-position"
        | "not-select-query";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "ambiguous-query-site"
        | "opaque-statement"
        | "resource-limit";
    }
  | {
      readonly status: "ready";
      readonly coverage: "complete" | "partial";
      readonly context: SqlColumnCompletionContext;
      readonly issues: readonly SqlColumnQuerySiteIssue[];
      readonly prefix: SqlIdentifierComponent;
      readonly qualifier: SqlIdentifierPath;
      readonly relations: readonly SqlColumnQueryRelation[];
      readonly replacementRange: SqlTextRange;
    };

interface Token extends BoundedSqlLexeme {
  readonly depth: number;
}

export type SqlColumnCompletionContext =
  | "from"
  | "group"
  | "having"
  | "join-condition"
  | "limit"
  | "order"
  | "qualify"
  | "select-list"
  | "using"
  | "where";

const RELATION_END_WORDS: ReadonlySet<string> = new Set([
  "cross",
  "except",
  "fetch",
  "full",
  "group",
  "having",
  "inner",
  "intersect",
  "join",
  "left",
  "limit",
  "natural",
  "offset",
  "on",
  "order",
  "qualify",
  "right",
  "union",
  "using",
  "where",
  "window",
]);

function inactive(
  reason: Extract<
    SqlColumnQuerySiteResult,
    { status: "inactive" }
  >["reason"],
): SqlColumnQuerySiteResult {
  return Object.freeze({ reason, status: "inactive" });
}

function unavailable(
  reason: Extract<
    SqlColumnQuerySiteResult,
    { status: "unavailable" }
  >["reason"],
): SqlColumnQuerySiteResult {
  return Object.freeze({ reason, status: "unavailable" });
}

function word(
  source: SqlSourceSnapshot,
  token: Token | undefined,
): string | null {
  return token?.kind === "word"
    ? source.analysisText.slice(token.from, token.to).toLowerCase()
    : null;
}

function isIdentifier(token: Token | undefined): boolean {
  return token?.kind === "word" ||
    token?.kind === "quoted-identifier";
}

function punctuation(
  source: SqlSourceSnapshot,
  token: Token | undefined,
  expected: string,
): boolean {
  return token?.kind === "punctuation" &&
    source.analysisText.slice(token.from, token.to) === expected;
}

function tokenize(
  source: SqlSourceSnapshot,
  slot: Extract<SqlStatementSlot, { boundaryQuality: "exact" }>,
  dialect: SqlRelationDialectRuntime,
): readonly Token[] | null {
  const lexer = new BoundedSqlLexer(
    source,
    slot.source.from,
    slot.source.to,
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

function decodePath(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  from: number,
  to: number,
): SqlIdentifierPath | null {
  const raw = source.analysisText.slice(from, to);
  const decoded = dialect.querySite.decodeRelationPath(raw, raw.length);
  if (
    decoded.status !== "decoded" ||
    decoded.prefix.value.length === 0
  ) {
    return null;
  }
  return Object.freeze([
    ...decoded.qualifier,
    decoded.prefix,
  ]);
}

function parseNamedRelation(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  tokens: readonly Token[],
  start: number,
  depth: number,
): {
  readonly next: number;
  readonly relation: SqlColumnQueryRelation | null;
  readonly issue: SqlColumnQuerySiteIssue | null;
} {
  const first = tokens[start];
  if (punctuation(source, first, "(") && first?.depth === depth) {
    const closeIndex = tokens.findIndex((token, index) =>
      index > start &&
      token.depth === depth &&
      punctuation(source, token, ")")
    );
    const close = tokens[closeIndex];
    const hasSelect = tokens.some((token, index) =>
      index > start &&
      index < closeIndex &&
      token.depth === depth + 1 &&
      word(source, token) === "select"
    );
    if (closeIndex < 0 || !close || !hasSelect) {
      return {
        issue: "derived-relation" as const,
        next: start + 1,
        relation: null,
      };
    }
    let end = closeIndex + 1;
    const maybeAs = word(source, tokens[end]);
    if (maybeAs === "as") end += 1;
    const aliasToken = tokens[end];
    const aliasWord = aliasToken ? word(source, aliasToken) : null;
    const aliasPath =
      isIdentifier(aliasToken) &&
        aliasToken?.depth === depth &&
        (aliasWord === null || !RELATION_END_WORDS.has(aliasWord))
        ? decodePath(
            source,
            dialect,
            aliasToken.from,
            aliasToken.to,
          )
        : null;
    const alias = aliasPath?.length === 1
      ? aliasPath[0] ?? null
      : null;
    if (alias !== null) end += 1;
    const parsedAliases = alias === null
      ? { aliases: undefined, next: end }
      : parseColumnAliases(
          source,
          dialect,
          tokens,
          end,
          depth,
        );
    end = parsedAliases.next;
    return {
      issue:
        alias === null
          ? "derived-relation" as const
          : parsedAliases.aliases?.coverage === "partial"
            ? "local-output-partial" as const
            : null,
      next: end,
      relation: Object.freeze({
        alias,
        ...(parsedAliases.aliases === undefined
          ? {}
          : { columnAliases: parsedAliases.aliases }),
        local: Object.freeze({
          kind: "derived" as const,
          queryRange: Object.freeze({
            from: first.to,
            to: close.from,
          }),
        }),
        path: Object.freeze([]),
        range: Object.freeze({
          from: first.from,
          to: close.to,
        }),
      }),
    };
  }
  if (!isIdentifier(first) || first?.depth !== depth) {
    return {
      issue: punctuation(source, first, "(")
        ? "derived-relation"
        : "incomplete-relation",
      next: start + 1,
      relation: null,
    };
  }
  let end = start + 1;
  while (
    punctuation(source, tokens[end], ".") &&
    tokens[end]?.depth === depth &&
    isIdentifier(tokens[end + 1]) &&
    tokens[end + 1]?.depth === depth
  ) {
    end += 2;
  }
  const lastPathToken = tokens[end - 1] ?? first;
  const path = decodePath(
    source,
    dialect,
    first.from,
    lastPathToken.to,
  );
  if (path === null) {
    return {
      issue: "incomplete-relation",
      next: end,
      relation: null,
    };
  }
  if (punctuation(source, tokens[end], "(")) {
    return {
      issue: "table-function",
      next: end + 1,
      relation: null,
    };
  }
  let alias: SqlIdentifierComponent | null = null;
  const maybeAs = word(source, tokens[end]);
  if (maybeAs === "as") end += 1;
  const aliasToken = tokens[end];
  const aliasWord = aliasToken ? word(source, aliasToken) : null;
  if (
    isIdentifier(aliasToken) &&
    aliasToken?.depth === depth &&
    (aliasWord === null ||
      !RELATION_END_WORDS.has(aliasWord))
  ) {
    const aliasPath = decodePath(
      source,
      dialect,
      aliasToken.from,
      aliasToken.to,
    );
    if (aliasPath?.length === 1) {
      alias = aliasPath[0] ?? null;
      end += 1;
    }
  }
  const parsedAliases = alias === null
    ? { aliases: undefined, next: end }
    : parseColumnAliases(
        source,
        dialect,
        tokens,
        end,
        depth,
      );
  end = parsedAliases.next;
  return {
    issue:
      maybeAs === "as" && alias === null
        ? "incomplete-relation"
        : parsedAliases.aliases?.coverage === "partial"
          ? "local-output-partial"
          : null,
    next: end,
    relation: Object.freeze({
      alias,
      ...(parsedAliases.aliases === undefined
        ? {}
        : { columnAliases: parsedAliases.aliases }),
      path,
      range: Object.freeze({
        from: first.from,
        to: lastPathToken.to,
      }),
    }),
  };
}

function clauseAt(
  source: SqlSourceSnapshot,
  tokens: readonly Token[],
  selectIndex: number,
  depth: number,
  position: number,
): SqlColumnCompletionContext {
  let clause: SqlColumnCompletionContext = "select-list";
  for (
    let index = selectIndex + 1;
    index < tokens.length && tokens[index]!.from < position;
    index += 1
  ) {
    const token = tokens[index]!;
    if (token.depth !== depth) continue;
    switch (word(source, token)) {
      case "from":
        clause = "from";
        break;
      case "group":
        clause = "group";
        break;
      case "having":
        clause = "having";
        break;
      case "limit":
      case "fetch":
      case "offset":
        clause = "limit";
        break;
      case "on":
        clause = "join-condition";
        break;
      case "using":
        clause = "using";
        break;
      case "order":
        clause = "order";
        break;
      case "qualify":
        clause = "qualify";
        break;
      case "where":
        clause = "where";
        break;
    }
  }
  return clause;
}

function typedPath(
  source: SqlSourceSnapshot,
  tokens: readonly Token[],
  position: number,
  dialect: SqlRelationDialectRuntime,
): {
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly replacementRange: SqlTextRange;
} | null {
  let endIndex = tokens.findIndex((token) =>
    token.from < position && position <= token.to
  );
  const endToken = tokens[endIndex];
  if (
    endIndex < 0 ||
    (!isIdentifier(endToken) &&
      !punctuation(source, endToken, "."))
  ) {
    return Object.freeze({
      prefix: Object.freeze({ quoted: false, value: "" }),
      qualifier: Object.freeze([]),
      replacementRange: Object.freeze({ from: position, to: position }),
    });
  }
  let startIndex = endIndex;
  let expectIdentifier = punctuation(source, endToken, ".");
  while (startIndex > 0) {
    const previous = tokens[startIndex - 1];
    if (
      expectIdentifier
        ? !isIdentifier(previous)
        : !punctuation(source, previous, ".")
    ) {
      break;
    }
    startIndex -= 1;
    expectIdentifier = !expectIdentifier;
  }
  const from = tokens[startIndex]?.from ?? position;
  const raw = source.analysisText.slice(from, position);
  const decoded = dialect.querySite.decodeRelationPath(raw, raw.length);
  if (decoded.status !== "decoded") return null;
  return Object.freeze({
    prefix: decoded.prefix,
    qualifier: decoded.qualifier,
    replacementRange: Object.freeze({
      from: from + decoded.finalSegment.from,
      to: from + decoded.finalSegment.to,
    }),
  });
}

function cursorTokenReason(
  tokens: readonly Token[],
  position: number,
): Extract<
  SqlColumnQuerySiteResult,
  { status: "inactive" }
>["reason"] | null {
  const token = tokens.find((candidate) =>
    candidate.from <= position &&
    (position < candidate.to ||
      (candidate.kind === "line-comment" &&
        position === candidate.to))
  );
  switch (token?.kind) {
    case "barrier":
      return "cursor-in-embedded-region";
    case "comment":
    case "line-comment":
      return "cursor-in-comment";
    case "string":
      return "cursor-in-string";
    default:
      return null;
  }
}

function collectRelations(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  tokens: readonly Token[],
  selectIndex: number,
  visibilityPosition: number,
  precedingOnly: boolean,
  relations: SqlColumnQueryRelation[],
  issues: Set<SqlColumnQuerySiteIssue>,
): boolean {
  const selectDepth = tokens[selectIndex]?.depth;
  if (selectDepth === undefined) return false;
  const clause = clauseAt(
    source,
    tokens,
    selectIndex,
    selectDepth,
    visibilityPosition,
  );
  let commaStartsRelation = false;
  let inFrom = false;
  for (
    let index = selectIndex + 1;
    index < tokens.length;
    index += 1
  ) {
    const token = tokens[index]!;
    if (
      (precedingOnly || clause === "join-condition") &&
      token.from >= visibilityPosition
    ) {
      break;
    }
    if (token.depth < selectDepth) break;
    if (token.depth !== selectDepth) {
      if (word(source, token) === "select") issues.add("nested-query");
      continue;
    }
    const tokenWord = word(source, token);
    if (
      tokenWord === "union" ||
      tokenWord === "intersect" ||
      tokenWord === "except"
    ) {
      break;
    }
    if (
      tokenWord === "where" ||
      tokenWord === "group" ||
      tokenWord === "having" ||
      tokenWord === "qualify" ||
      tokenWord === "order" ||
      tokenWord === "limit"
    ) {
      inFrom = false;
      commaStartsRelation = false;
      continue;
    }
    if (tokenWord === "on" || tokenWord === "using") {
      commaStartsRelation = false;
      continue;
    }
    const startsRelation =
      tokenWord === "from" ||
      tokenWord === "join" ||
      (inFrom &&
        commaStartsRelation &&
        punctuation(source, token, ","));
    if (!startsRelation) continue;
    inFrom = true;
    let relationIndex = index + 1;
    if (
      (dialect.id === "postgresql" || dialect.id === "duckdb") &&
      word(source, tokens[relationIndex]) === "lateral"
    ) {
      relationIndex += 1;
    }
    const parsed = parseNamedRelation(
      source,
      dialect,
      tokens,
      relationIndex,
      selectDepth,
    );
    if (parsed.issue !== null) issues.add(parsed.issue);
    if (parsed.relation !== null) {
      if (
        precedingOnly &&
        parsed.relation.range.to >= visibilityPosition
      ) {
        break;
      }
      relations.push(parsed.relation);
      if (relations.length > MAX_COLUMN_QUERY_RELATIONS) return false;
    }
    commaStartsRelation = true;
    index = Math.max(index, parsed.next - 1);
  }
  return true;
}

function openingBefore(
  source: SqlSourceSnapshot,
  tokens: readonly Token[],
  beforeIndex: number,
  depth: number,
): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (
      token.depth === depth &&
      punctuation(source, token, "(")
    ) {
      return index;
    }
  }
  return -1;
}

function correlatedParentSelectIndex(
  source: SqlSourceSnapshot,
  dialect: SqlRelationDialectRuntime,
  tokens: readonly Token[],
  childIndex: number,
): readonly [selectIndex: number, precedingOnly: boolean] | null {
  const child = tokens[childIndex];
  if (!child || child.depth === 0) return null;
  for (let depth = child.depth - 1; depth >= 0; depth -= 1) {
    const lowerBound = depth === 0
      ? -1
      : tokens[
          openingBefore(source, tokens, childIndex, depth - 1)
        ]?.from ?? -1;
    for (let index = childIndex - 1; index >= 0; index -= 1) {
      const token = tokens[index]!;
      if (token.from <= lowerBound) break;
      if (token.depth === depth && word(source, token) === "select") {
        const openingIndex = openingBefore(
          source,
          tokens,
          childIndex,
          depth,
        );
        const opening = tokens[openingIndex]?.from ?? -1;
        if (opening <= token.from) return null;
        const inFrom =
          clauseAt(
            source,
            tokens,
            index,
            depth,
            opening,
          ) === "from";
        if (!inFrom) return [index, false];
        return (dialect.id === "postgresql" || dialect.id === "duckdb") &&
            word(source, tokens[openingIndex - 1]) === "lateral"
          ? [index, true]
          : null;
      }
    }
  }
  return null;
}

export function recognizeSqlColumnQuerySite(
  source: SqlSourceSnapshot,
  slot: SqlStatementSlot,
  position: number,
  dialect: SqlRelationDialectRuntime,
): SqlColumnQuerySiteResult {
  if (
    !isSqlSourceSnapshot(source) ||
    !isSqlStatementSlotSnapshot(slot) ||
    !isSqlRelationDialectRuntime(dialect) ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > source.analysisText.length
  ) {
    return unavailable("ambiguous-query-site");
  }
  if (slot.boundaryQuality === "opaque") {
    return unavailable("opaque-statement");
  }
  if (
    position < slot.source.from ||
    position > slot.source.to
  ) {
    return inactive("not-column-position");
  }
  const tokens = tokenize(source, slot, dialect);
  if (tokens === null) return unavailable("resource-limit");
  const cursorReason = cursorTokenReason(tokens, position);
  if (cursorReason !== null) return inactive(cursorReason);

  let cursorDepth = 0;
  for (const token of tokens) {
    if (token.from >= position) break;
    cursorDepth = token.depth;
    if (punctuation(source, token, "(")) cursorDepth += 1;
  }
  let selectIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (
      token.from <= position &&
      token.depth <= cursorDepth &&
      word(source, token) === "select"
    ) {
      selectIndex = index;
    }
  }
  if (selectIndex < 0) return inactive("not-select-query");
  const selectDepth = tokens[selectIndex]!.depth;
  const clause = clauseAt(
    source,
    tokens,
    selectIndex,
    selectDepth,
    position,
  );
  if (clause === "from" || clause === "limit") {
    return inactive("not-column-position");
  }
  const path = typedPath(source, tokens, position, dialect);
  if (path === null) {
    return inactive("not-column-position");
  }

  const relations: SqlColumnQueryRelation[] = [];
  const issues = new Set<SqlColumnQuerySiteIssue>();
  if (
    !collectRelations(
      source,
      dialect,
      tokens,
      selectIndex,
      position,
      false,
      relations,
      issues,
    )
  ) {
    return unavailable("resource-limit");
  }
  let childIndex = selectIndex;
  for (;;) {
    const parent = correlatedParentSelectIndex(
      source,
      dialect,
      tokens,
      childIndex,
    );
    if (parent === null) break;
    const [parentIndex, precedingOnly] = parent;
    const childPosition = tokens[childIndex]?.from;
    if (
      childPosition === undefined ||
      !collectRelations(
        source,
        dialect,
        tokens,
        parentIndex,
        childPosition,
        precedingOnly,
        relations,
        issues,
      )
    ) {
      return unavailable("resource-limit");
    }
    childIndex = parentIndex;
  }
  const issueList = Object.freeze(Array.from(issues).sort());
  return Object.freeze({
    coverage: issueList.length === 0 ? "complete" : "partial",
    context: clause,
    issues: issueList,
    prefix: path.prefix,
    qualifier: path.qualifier,
    relations: Object.freeze(relations),
    replacementRange: path.replacementRange,
    status: "ready",
  });
}
