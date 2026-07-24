import {
  hasEscapeStringPrefix,
  isBigQueryRawString,
  isSqlWhitespace,
  scanSqlBlockComment,
  scanSqlDollarQuote,
  scanSqlQuoted,
  sqlIdentifierContinueLengthAt,
  sqlIdentifierStartLengthAt,
  type SqlLexicalProfile,
} from "./lexical.js";
import type { SqlSourceSnapshot } from "./source.js";
import type {
  ExactSqlStatementSlot,
  SqlStatementSlot,
} from "./statement-index.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

const querySiteRangeBrand: unique symbol = Symbol("SqlQuerySiteRange");

export const MAX_QUERY_SITE_STATEMENT_LENGTH = 65_536;
export const MAX_QUERY_SITE_LEXEMES = 16_384;
export const MAX_QUERY_SITE_DEPTH = 128;
export const MAX_QUERY_SITE_PATH_COMPONENTS = 4;
export const MAX_QUERY_SITE_IDENTIFIER_LENGTH = 256;

export interface SqlQuerySiteRange {
  readonly [querySiteRangeBrand]: "SqlQuerySiteRange";
  readonly from: number;
  readonly to: number;
}

export type SqlQuerySiteResource =
  | "active-statement"
  | "identifier-path"
  | "identifier-segment"
  | "lexical-token"
  | "parenthesis-depth";

export type SqlQuerySiteIssue =
  | "incomplete-identifier"
  | "opaque-template-context";

export type SqlQuerySiteResult =
  | {
      readonly status: "inactive";
      readonly reason:
        | "not-select-query"
        | "not-relation-position"
        | "cursor-in-comment"
        | "cursor-in-string"
        | "cursor-in-embedded-region";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "opaque-statement"
        | "resource-limit"
        | "ambiguous-query-site"
        | "unsupported-query-site";
      readonly resource?: SqlQuerySiteResource;
    }
  | {
      readonly status: "ready";
      readonly anchor: "comma" | "from" | "join";
      readonly qualifier: SqlIdentifierPath;
      readonly prefix: SqlIdentifierComponent;
      readonly finalSegmentRange: SqlQuerySiteRange;
      readonly typedPathRange: SqlQuerySiteRange;
      readonly recognition:
        | {
            readonly quality: "exact";
            readonly issues: readonly [];
          }
        | {
            readonly quality: "recovered";
            readonly issues: readonly [
              SqlQuerySiteIssue,
              ...SqlQuerySiteIssue[],
            ];
          };
    };

export type SqlDecodedQueryPath =
  | {
      readonly status: "decoded";
      readonly qualifier: SqlIdentifierPath;
      readonly prefix: SqlIdentifierComponent;
      readonly finalSegment: {
        readonly from: number;
        readonly to: number;
      };
      readonly quality: "exact" | "recovered";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "invalid-identifier"
        | "unsupported-quote"
        | "undecodable-identifier";
    };

export interface SqlQuerySiteDialect {
  readonly lexicalProfile: SqlLexicalProfile;
  readonly decodeRelationPath: (
    rawPath: string,
    cursorOffset: number,
  ) => SqlDecodedQueryPath;
}

type LexemeKind =
  | "barrier"
  | "comment"
  | "other"
  | "punctuation"
  | "quoted-identifier"
  | "string"
  | "word";

interface Lexeme {
  readonly closed: boolean;
  readonly from: number;
  readonly kind: LexemeKind;
  readonly to: number;
}

type FrameState =
  | "after-alias"
  | "after-relation"
  | "closed"
  | "expect-alias"
  | "expect-relation"
  | "join-constraint"
  | "select-list"
  | "unavailable";

interface QueryFrame {
  readonly baseDepth: number;
  anchor: "comma" | "from" | "join";
  joinPrefix:
    | "cross"
    | "full"
    | "full-outer"
    | "inner"
    | "left"
    | "left-outer"
    | "natural"
    | "right"
    | "right-outer"
    | null;
  selectWords: [string | null, string | null, string | null];
  state: FrameState;
  tainted: boolean;
  unavailableReason: "ambiguous-query-site" | "unsupported-query-site";
}

function inactive(
  reason: Extract<SqlQuerySiteResult, { status: "inactive" }>["reason"],
): SqlQuerySiteResult {
  return Object.freeze({ reason, status: "inactive" });
}

function unavailable(
  reason: Extract<SqlQuerySiteResult, { status: "unavailable" }>["reason"],
  resource?: SqlQuerySiteResource,
): SqlQuerySiteResult {
  return Object.freeze(
    resource === undefined
      ? { reason, status: "unavailable" }
      : { reason, resource, status: "unavailable" },
  );
}

function createRange(from: number, to: number): SqlQuerySiteRange {
  const range: SqlQuerySiteRange = {
    [querySiteRangeBrand]: "SqlQuerySiteRange",
    from,
    to,
  };
  return Object.freeze(range);
}

function findRegionAtOrAfter(source: SqlSourceSnapshot, position: number): number {
  let low = 0;
  let high = source.embeddedRegions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const region = source.embeddedRegions[middle];
    if (!region || region.to <= position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function regionContains(source: SqlSourceSnapshot, position: number): boolean {
  const region = source.embeddedRegions[
    findRegionAtOrAfter(source, position)
  ];
  return Boolean(region && region.from <= position && position < region.to);
}

class QueryLexer {
  readonly #profile: SqlLexicalProfile;
  readonly #source: SqlSourceSnapshot;
  readonly #to: number;
  #cursor: number;
  #lexemeCount = 0;
  #pushed: Lexeme | null = null;
  #regionIndex: number;
  resource: SqlQuerySiteResource | null = null;

  constructor(
    source: SqlSourceSnapshot,
    from: number,
    to: number,
    profile: SqlLexicalProfile,
  ) {
    this.#source = source;
    this.#cursor = from;
    this.#to = to;
    this.#profile = profile;
    this.#regionIndex = findRegionAtOrAfter(source, from);
  }

  next(): Lexeme | null {
    if (this.#pushed) {
      const lexeme = this.#pushed;
      this.#pushed = null;
      return lexeme;
    }
    const text = this.#source.analysisText;
    while (this.#cursor < this.#to) {
      const region = this.#source.embeddedRegions[this.#regionIndex];
      if (region && region.from <= this.#cursor) {
        const from = this.#cursor;
        this.#cursor = Math.min(region.to, this.#to);
        this.#regionIndex += 1;
        return this.#record({
          closed: true,
          from,
          kind: "barrier",
          to: this.#cursor,
        });
      }
      const lexicalLimit = Math.min(region?.from ?? this.#to, this.#to);
      const code = text.charCodeAt(this.#cursor);
      if (isSqlWhitespace(code)) {
        this.#cursor += 1;
        continue;
      }
      const from = this.#cursor;
      const next = text.charCodeAt(from + 1);
      if (code === 45 && next === 45) {
        this.#cursor += 2;
        while (
          this.#cursor < lexicalLimit &&
          text.charCodeAt(this.#cursor) !== 10 &&
          text.charCodeAt(this.#cursor) !== 13
        ) {
          this.#cursor += 1;
        }
        return this.#record({
          closed: true,
          from,
          kind: "comment",
          to: this.#cursor,
        });
      }
      if (this.#profile.hashLineComments && code === 35) {
        this.#cursor += 1;
        while (
          this.#cursor < lexicalLimit &&
          text.charCodeAt(this.#cursor) !== 10 &&
          text.charCodeAt(this.#cursor) !== 13
        ) {
          this.#cursor += 1;
        }
        return this.#record({
          closed: true,
          from,
          kind: "comment",
          to: this.#cursor,
        });
      }
      if (code === 47 && next === 42) {
        const result = scanSqlBlockComment(
          text,
          from,
          lexicalLimit,
          this.#profile.nestedBlockComments,
        );
        this.#cursor = result.to;
        return this.#record({
          closed: result.closed,
          from,
          kind: "comment",
          to: result.to,
        });
      }
      if (this.#profile.dollarQuotedStrings && code === 36) {
        const result = scanSqlDollarQuote(text, from, lexicalLimit);
        if (result) {
          this.#cursor = result.to;
          if (result.delimiterTooLong) {
            this.resource = "identifier-segment";
            return null;
          }
          return this.#record({
            closed: result.closed,
            from,
            kind: "string",
            to: result.to,
          });
        }
      }
      if (code === 96 && this.#profile.backtickQuotedIdentifiers) {
        const result = scanSqlQuoted(
          text,
          from,
          lexicalLimit,
          code,
          1,
          true,
          false,
          false,
        );
        this.#cursor = result.to;
        return this.#record({
          closed: result.closed,
          from,
          kind: "quoted-identifier",
          to: result.to,
        });
      }
      if (code === 39 || code === 34) {
        const triple =
          this.#profile.bigQueryStrings &&
          text.charCodeAt(from + 1) === code &&
          text.charCodeAt(from + 2) === code;
        const quotedIdentifier = code === 34 && !this.#profile.bigQueryStrings;
        const rawBigQueryString =
          this.#profile.bigQueryStrings &&
          isBigQueryRawString(text, from);
        const backslashEscapes =
          !rawBigQueryString &&
          (this.#profile.bigQueryStrings ||
          (code === 39 &&
            (this.#profile.singleQuoteBackslash === "always" ||
              (this.#profile.singleQuoteBackslash === "e-prefix" &&
                hasEscapeStringPrefix(text, from)))));
        const result = scanSqlQuoted(
          text,
          from,
          lexicalLimit,
          code,
          triple ? 3 : 1,
          backslashEscapes,
          !triple,
          this.#profile.bigQueryStrings && !triple,
        );
        this.#cursor = result.to;
        return this.#record({
          closed: result.closed,
          from,
          kind: quotedIdentifier ? "quoted-identifier" : "string",
          to: result.to,
        });
      }
      const startLength = sqlIdentifierStartLengthAt(text, from);
      if (startLength > 0) {
        this.#cursor += startLength;
        while (this.#cursor < lexicalLimit) {
          const length = sqlIdentifierContinueLengthAt(text, this.#cursor);
          if (length === 0) {
            break;
          }
          this.#cursor += length;
        }
        return this.#record({
          closed: true,
          from,
          kind: "word",
          to: this.#cursor,
        });
      }
      this.#cursor += 1;
      return this.#record({
        closed: true,
        from,
        kind:
          code === 40 ||
          code === 41 ||
          code === 44 ||
          code === 46 ||
          code === 59
            ? "punctuation"
            : "other",
        to: this.#cursor,
      });
    }
    return null;
  }

  pushBack(lexeme: Lexeme): void {
    this.#pushed = lexeme;
  }

  #record(lexeme: Lexeme): Lexeme | null {
    this.#lexemeCount += 1;
    if (this.#lexemeCount > MAX_QUERY_SITE_LEXEMES) {
      this.resource = "lexical-token";
      return null;
    }
    return lexeme;
  }
}

function wordEquals(text: string, token: Lexeme, expected: string): boolean {
  if (token.to - token.from !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      (text.charCodeAt(token.from + index) | 32) !==
      expected.charCodeAt(index)
    ) {
      return false;
    }
  }
  return true;
}

function wordValue(text: string, token: Lexeme): string {
  return token.to - token.from <= 16
    ? text.slice(token.from, token.to).toLowerCase()
    : "";
}

function topFrame(frames: readonly QueryFrame[]): QueryFrame | null {
  return frames[frames.length - 1] ?? null;
}

function createFrame(depth: number): QueryFrame {
  return {
    anchor: "from",
    baseDepth: depth,
    joinPrefix: null,
    selectWords: [null, null, null],
    state: "select-list",
    tainted: false,
    unavailableReason: "ambiguous-query-site",
  };
}

function isClauseCloser(word: string): boolean {
  return (
    word === "fetch" ||
    word === "group" ||
    word === "having" ||
    word === "limit" ||
    word === "offset" ||
    word === "order" ||
    word === "where"
  );
}

function isSetOperation(word: string): boolean {
  return word === "except" || word === "intersect" || word === "union";
}

function pushSelectWord(frame: QueryFrame, word: string): void {
  frame.selectWords = [frame.selectWords[1], frame.selectWords[2], word];
}

function isExpressionFrom(frame: QueryFrame): boolean {
  const [first, second] = [frame.selectWords[1], frame.selectWords[2]];
  return (
    (first === "is" && second === "distinct") ||
    (frame.selectWords[0] === "is" &&
      first === "not" &&
      second === "distinct")
  );
}

function markUnavailable(
  frame: QueryFrame,
  reason: QueryFrame["unavailableReason"],
): void {
  frame.state = "unavailable";
  frame.unavailableReason = reason;
}

function processFrameWord(frame: QueryFrame, word: string): void {
  if (frame.state === "unavailable" || frame.state === "closed") {
    return;
  }
  if (isSetOperation(word)) {
    markUnavailable(frame, "unsupported-query-site");
    return;
  }
  if (word === "qualify" || word === "window") {
    markUnavailable(frame, "unsupported-query-site");
    return;
  }
  if (isClauseCloser(word)) {
    frame.state = "closed";
    frame.joinPrefix = null;
    return;
  }
  if (frame.state === "select-list") {
    if (word === "from" && !isExpressionFrom(frame)) {
      frame.anchor = "from";
      frame.state = "expect-relation";
      frame.joinPrefix = null;
      return;
    }
    pushSelectWord(frame, word);
    return;
  }
  if (frame.state === "join-constraint") {
    if (word === "join") {
      frame.anchor = "join";
      frame.state = "expect-relation";
    }
    return;
  }
  if (frame.state === "expect-alias") {
    frame.state = "after-alias";
    return;
  }
  if (frame.state !== "after-relation" && frame.state !== "after-alias") {
    return;
  }
  if (word === "on" || word === "using") {
    frame.state = "join-constraint";
    frame.joinPrefix = null;
    return;
  }
  if (word === "join") {
    frame.anchor = "join";
    frame.state = "expect-relation";
    frame.joinPrefix = null;
    return;
  }
  if (word === "as" && frame.state === "after-relation") {
    frame.state = "expect-alias";
    return;
  }
  if (word === "outer") {
    if (frame.joinPrefix === "left") {
      frame.joinPrefix = "left-outer";
      return;
    }
    if (frame.joinPrefix === "right") {
      frame.joinPrefix = "right-outer";
      return;
    }
    if (frame.joinPrefix === "full") {
      frame.joinPrefix = "full-outer";
      return;
    }
    markUnavailable(frame, "ambiguous-query-site");
    return;
  }
  if (
    word === "cross" ||
    word === "full" ||
    word === "inner" ||
    word === "left" ||
    word === "natural" ||
    word === "right"
  ) {
    if (frame.joinPrefix !== null) {
      markUnavailable(frame, "ambiguous-query-site");
      return;
    }
    frame.joinPrefix = word;
    return;
  }
  if (frame.joinPrefix !== null) {
    markUnavailable(frame, "ambiguous-query-site");
    return;
  }
  if (frame.state === "after-relation") {
    frame.state = "after-alias";
    return;
  }
  markUnavailable(frame, "ambiguous-query-site");
}

function processBarrier(frame: QueryFrame | null): void {
  if (!frame || frame.state === "closed" || frame.state === "unavailable") {
    return;
  }
  frame.tainted = true;
  frame.joinPrefix = null;
  if (frame.state === "expect-relation") {
    frame.state = "after-relation";
  } else if (frame.state === "expect-alias") {
    markUnavailable(frame, "ambiguous-query-site");
  }
}

function intersectsRegion(
  source: SqlSourceSnapshot,
  from: number,
  to: number,
): boolean {
  const region = source.embeddedRegions[findRegionAtOrAfter(source, from)];
  return Boolean(region && region.from < to && from < region.to);
}

function freezeComponent(component: SqlIdentifierComponent): SqlIdentifierComponent {
  return Object.freeze({
    quoted: component.quoted,
    value: component.value,
  });
}

function readyEmpty(
  slot: ExactSqlStatementSlot,
  frame: QueryFrame,
  position: number,
): SqlQuerySiteResult {
  const offset = position - slot.source.from;
  const emptyPrefix = Object.freeze({ quoted: false, value: "" });
  const recognition = frame.tainted
    ? Object.freeze({
        issues: Object.freeze([
          "opaque-template-context",
        ]) as readonly ["opaque-template-context"],
        quality: "recovered" as const,
      })
    : Object.freeze({
        issues: Object.freeze([]) as readonly [],
        quality: "exact" as const,
      });
  return Object.freeze({
    anchor: frame.anchor,
    finalSegmentRange: createRange(offset, offset),
    prefix: emptyPrefix,
    qualifier: Object.freeze([]),
    recognition,
    status: "ready",
    typedPathRange: createRange(offset, offset),
  });
}

function decodeReadyPath(
  source: SqlSourceSnapshot,
  slot: ExactSqlStatementSlot,
  frame: QueryFrame,
  dialect: SqlQuerySiteDialect,
  rawFrom: number,
  rawTo: number,
  position: number,
): SqlQuerySiteResult {
  if (intersectsRegion(source, rawFrom, rawTo)) {
    return unavailable("ambiguous-query-site");
  }
  const rawPath = source.originalText.slice(rawFrom, rawTo);
  const decoded = dialect.decodeRelationPath(rawPath, position - rawFrom);
  if (decoded.status === "unavailable") {
    return unavailable("ambiguous-query-site");
  }
  if (
    decoded.qualifier.length + 1 > MAX_QUERY_SITE_PATH_COMPONENTS
  ) {
    return unavailable("resource-limit", "identifier-path");
  }
  const components = [...decoded.qualifier, decoded.prefix];
  if (
    components.some(
      (component) =>
        typeof component.value !== "string" ||
        component.value.length > MAX_QUERY_SITE_IDENTIFIER_LENGTH ||
        typeof component.quoted !== "boolean",
    )
  ) {
    return unavailable("resource-limit", "identifier-segment");
  }
  const finalFrom = decoded.finalSegment.from;
  const finalTo = decoded.finalSegment.to;
  const cursorOffset = position - rawFrom;
  if (
    !Number.isSafeInteger(finalFrom) ||
    !Number.isSafeInteger(finalTo) ||
    finalFrom < 0 ||
    finalFrom > cursorOffset ||
    cursorOffset > finalTo ||
    finalTo > rawPath.length
  ) {
    return unavailable("ambiguous-query-site");
  }
  const issues: SqlQuerySiteIssue[] = [];
  if (frame.tainted) {
    issues.push("opaque-template-context");
  }
  if (decoded.quality === "recovered") {
    issues.push("incomplete-identifier");
  }
  const qualifier = Object.freeze(decoded.qualifier.map(freezeComponent));
  const prefix = freezeComponent(decoded.prefix);
  const recognition =
    issues.length === 0
      ? Object.freeze({
          issues: Object.freeze([]) as readonly [],
          quality: "exact" as const,
        })
      : Object.freeze({
          issues: Object.freeze(issues) as readonly [
            SqlQuerySiteIssue,
            ...SqlQuerySiteIssue[],
          ],
          quality: "recovered" as const,
        });
  return Object.freeze({
    anchor: frame.anchor,
    finalSegmentRange: createRange(
      rawFrom - slot.source.from + finalFrom,
      rawFrom - slot.source.from + finalTo,
    ),
    prefix,
    qualifier,
    recognition,
    status: "ready",
    typedPathRange: createRange(
      rawFrom - slot.source.from,
      rawTo - slot.source.from,
    ),
  });
}

function recognizePath(
  lexer: QueryLexer,
  source: SqlSourceSnapshot,
  slot: ExactSqlStatementSlot,
  frame: QueryFrame,
  dialect: SqlQuerySiteDialect,
  first: Lexeme,
  position: number,
): SqlQuerySiteResult | null {
  let current = first;
  let pathComponents = 1;
  const rawFrom = first.from;
  let rawTo = first.to;
  while (true) {
    if (position <= current.to) {
      return decodeReadyPath(
        source,
        slot,
        frame,
        dialect,
        rawFrom,
        rawTo,
        position,
      );
    }
    const dot = lexer.next();
    if (lexer.resource) {
      return unavailable("resource-limit", lexer.resource);
    }
    if (
      !dot ||
      dot.from !== current.to ||
      dot.kind !== "punctuation" ||
      source.analysisText.charCodeAt(dot.from) !== 46
    ) {
      if (dot) {
        lexer.pushBack(dot);
      }
      frame.state = "after-relation";
      return null;
    }
    rawTo = dot.to;
    if (position <= dot.to) {
      return decodeReadyPath(
        source,
        slot,
        frame,
        dialect,
        rawFrom,
        rawTo,
        position,
      );
    }
    const identifier = lexer.next();
    if (lexer.resource) {
      return unavailable("resource-limit", lexer.resource);
    }
    if (
      !identifier ||
      identifier.from !== dot.to ||
      (identifier.kind !== "word" &&
        identifier.kind !== "quoted-identifier")
    ) {
      return unavailable("ambiguous-query-site");
    }
    pathComponents += 1;
    if (pathComponents > MAX_QUERY_SITE_PATH_COMPONENTS) {
      return unavailable("resource-limit", "identifier-path");
    }
    current = identifier;
    rawTo = identifier.to;
  }
}

function resultAtGap(
  slot: ExactSqlStatementSlot,
  frame: QueryFrame | null,
  position: number,
  sawSelect: boolean,
): SqlQuerySiteResult {
  if (!frame) {
    return inactive(sawSelect ? "not-relation-position" : "not-select-query");
  }
  if (frame.state === "unavailable") {
    return unavailable(frame.unavailableReason);
  }
  if (frame.state === "expect-relation") {
    return readyEmpty(slot, frame, position);
  }
  return inactive("not-relation-position");
}

export function recognizeSqlRelationQuerySite(
  source: SqlSourceSnapshot,
  slot: SqlStatementSlot,
  position: number,
  dialect: SqlQuerySiteDialect,
): SqlQuerySiteResult {
  if (slot.boundaryQuality === "opaque") {
    return unavailable("opaque-statement");
  }
  if (
    !Number.isSafeInteger(position) ||
    position < slot.source.from ||
    position > slot.source.to
  ) {
    return inactive("not-relation-position");
  }
  if (regionContains(source, position)) {
    return inactive("cursor-in-embedded-region");
  }
  if (
    slot.source.to - slot.source.from >
    MAX_QUERY_SITE_STATEMENT_LENGTH
  ) {
    return unavailable("resource-limit", "active-statement");
  }

  const lexer = new QueryLexer(
    source,
    slot.source.from,
    slot.source.to,
    dialect.lexicalProfile,
  );
  const frames: QueryFrame[] = [];
  const queryCandidates = new Set<number>([0]);
  let depth = 0;
  let sawSelect = false;

  while (true) {
    const token = lexer.next();
    if (lexer.resource) {
      return unavailable("resource-limit", lexer.resource);
    }
    const frame = topFrame(frames);
    if (!token || token.from > position) {
      return resultAtGap(slot, frame, position, sawSelect);
    }
    if (
      token.from === position &&
      frame?.state === "expect-relation" &&
      token.kind === "punctuation" &&
      source.analysisText.charCodeAt(token.from) === 41
    ) {
      return readyEmpty(slot, frame, position);
    }
    const cursorInside = token.from <= position && position < token.to;
    if (token.kind === "comment") {
      if (cursorInside) {
        return inactive("cursor-in-comment");
      }
      if (!token.closed) {
        return unavailable("ambiguous-query-site");
      }
      continue;
    }
    if (token.kind === "string") {
      if (cursorInside) {
        return inactive("cursor-in-string");
      }
      if (!token.closed) {
        return unavailable("ambiguous-query-site");
      }
    }
    if (token.kind === "barrier") {
      processBarrier(frame);
      queryCandidates.delete(depth);
      continue;
    }

    const active = topFrame(frames);
    if (
      active?.state === "expect-relation" &&
      (token.kind === "word" || token.kind === "quoted-identifier")
    ) {
      const pathResult = recognizePath(
        lexer,
        source,
        slot,
        active,
        dialect,
        token,
        position,
      );
      if (pathResult) {
        return pathResult;
      }
      continue;
    }
    if (cursorInside) {
      return inactive("not-relation-position");
    }
    if (
      active?.state === "expect-relation" &&
      (token.kind === "other" || token.kind === "string")
    ) {
      markUnavailable(
        active,
        token.kind === "string"
          ? "unsupported-query-site"
          : "ambiguous-query-site",
      );
      continue;
    }

    if (token.kind === "punctuation") {
      const code = source.analysisText.charCodeAt(token.from);
      const punctuationFrame = topFrame(frames);
      if (
        punctuationFrame?.baseDepth === depth &&
        punctuationFrame.state === "expect-relation" &&
        code !== 41
      ) {
        markUnavailable(
          punctuationFrame,
          code === 40
            ? "unsupported-query-site"
            : "ambiguous-query-site",
        );
      }
      if (code === 40) {
        const activeBeforeOpen = topFrame(frames);
        if (
          activeBeforeOpen?.baseDepth === depth &&
          activeBeforeOpen.state === "after-relation"
        ) {
          markUnavailable(activeBeforeOpen, "unsupported-query-site");
        }
        depth += 1;
        if (depth > MAX_QUERY_SITE_DEPTH) {
          return unavailable("resource-limit", "parenthesis-depth");
        }
        queryCandidates.add(depth);
      } else if (code === 41) {
        queryCandidates.delete(depth);
        while (
          frames.length > 0 &&
          (topFrame(frames)?.baseDepth ?? -1) >= depth
        ) {
          frames.pop();
        }
        depth = Math.max(0, depth - 1);
      } else if (code === 44) {
        const commaFrame = topFrame(frames);
        if (
          commaFrame?.baseDepth === depth &&
          (commaFrame.state === "after-relation" ||
            commaFrame.state === "after-alias")
        ) {
          commaFrame.anchor = "comma";
          commaFrame.joinPrefix = null;
          commaFrame.state = "expect-relation";
        }
      }
      if (token.to === position) {
        return resultAtGap(slot, topFrame(frames), position, sawSelect);
      }
      continue;
    }

    if (token.kind === "word") {
      const isSelect = wordEquals(source.analysisText, token, "select");
      if (queryCandidates.has(depth)) {
        queryCandidates.delete(depth);
        if (isSelect) {
          frames.push(createFrame(depth));
          sawSelect = true;
          if (token.to === position) {
            return inactive("not-relation-position");
          }
          continue;
        }
      }
      const activeFrame = topFrame(frames);
      if (activeFrame?.baseDepth === depth) {
        processFrameWord(
          activeFrame,
          wordValue(source.analysisText, token),
        );
      }
    } else if (queryCandidates.has(depth)) {
      queryCandidates.delete(depth);
    }
    if (token.to === position) {
      return resultAtGap(slot, topFrame(frames), position, sawSelect);
    }
  }
}
