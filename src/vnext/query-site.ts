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
export const MAX_QUERY_SITE_PATH_COMPONENTS = 32;
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
  readonly maximumPathDepth: number;
  readonly decodeRelationPath: (
    rawPath: string,
    cursorOffset: number,
  ) => SqlDecodedQueryPath;
}

type LexemeKind =
  | "barrier"
  | "comment"
  | "line-comment"
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
  joinConstraintAllowed: boolean;
  joinConstraintSeen: boolean;
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
          this.#cursor < this.#to &&
          text.charCodeAt(this.#cursor) !== 10 &&
          text.charCodeAt(this.#cursor) !== 13
        ) {
          this.#cursor += 1;
        }
        this.#advanceCoveredRegions();
        return this.#record({
          closed: true,
          from,
          kind: "line-comment",
          to: this.#cursor,
        });
      }
      if (this.#profile.hashLineComments && code === 35) {
        this.#cursor += 1;
        while (
          this.#cursor < this.#to &&
          text.charCodeAt(this.#cursor) !== 10 &&
          text.charCodeAt(this.#cursor) !== 13
        ) {
          this.#cursor += 1;
        }
        this.#advanceCoveredRegions();
        return this.#record({
          closed: true,
          from,
          kind: "line-comment",
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
          !this.#profile.bigQueryStrings,
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

  #advanceCoveredRegions(): void {
    while (
      (this.#source.embeddedRegions[this.#regionIndex]?.to ?? Infinity) <=
      this.#cursor
    ) {
      this.#regionIndex += 1;
    }
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

function isCommentLexeme(token: Lexeme): boolean {
  return token.kind === "comment" || token.kind === "line-comment";
}

function cursorIsInComment(token: Lexeme, position: number): boolean {
  return (
    token.from <= position &&
    (position < token.to ||
      (token.kind === "line-comment" && position === token.to))
  );
}

function createFrame(depth: number, tainted: boolean): QueryFrame {
  return {
    anchor: "from",
    baseDepth: depth,
    joinConstraintAllowed: false,
    joinConstraintSeen: false,
    joinPrefix: null,
    selectWords: [null, null, null],
    state: "select-list",
    tainted,
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

function joinAllowsConstraint(
  prefix: QueryFrame["joinPrefix"],
): boolean {
  return prefix !== "cross" && prefix !== "natural";
}

function processFrameWord(frame: QueryFrame, word: string): void {
  if (frame.state === "unavailable" || frame.state === "closed") {
    return;
  }
  if (isSetOperation(word)) {
    markUnavailable(frame, "unsupported-query-site");
    return;
  }
  if (word === "lateral" || word === "qualify" || word === "window") {
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
      frame.joinConstraintAllowed = false;
      frame.joinConstraintSeen = false;
      frame.state = "expect-relation";
      frame.joinPrefix = null;
      return;
    }
    pushSelectWord(frame, word);
    return;
  }
  if (frame.state === "join-constraint") {
    if (word === "on" || word === "using") {
      markUnavailable(frame, "ambiguous-query-site");
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
    if (word === "join") {
      frame.anchor = "join";
      frame.joinConstraintAllowed = joinAllowsConstraint(frame.joinPrefix);
      frame.joinConstraintSeen = false;
      frame.joinPrefix = null;
      frame.state = "expect-relation";
      return;
    }
    if (frame.joinPrefix !== null) {
      markUnavailable(frame, "ambiguous-query-site");
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
    if (
      frame.anchor !== "join" ||
      !frame.joinConstraintAllowed ||
      frame.joinConstraintSeen
    ) {
      markUnavailable(frame, "ambiguous-query-site");
      return;
    }
    frame.state = "join-constraint";
    frame.joinConstraintSeen = true;
    frame.joinPrefix = null;
    return;
  }
  if (word === "join") {
    frame.anchor = "join";
    frame.joinConstraintAllowed = joinAllowsConstraint(frame.joinPrefix);
    frame.joinConstraintSeen = false;
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

const INVALID_DATA_PROPERTY: unique symbol = Symbol("invalid-data-property");

function ownDataProperty(
  value: object,
  key: PropertyKey,
): unknown | typeof INVALID_DATA_PROPERTY {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : INVALID_DATA_PROPERTY;
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type ComponentValidation =
  | {
      readonly status: "valid";
      readonly component: SqlIdentifierComponent;
    }
  | {
      readonly status: "invalid";
    }
  | {
      readonly status: "resource-limit";
    };

function validateDecodedComponent(value: unknown): ComponentValidation {
  if (!isPlainRecord(value)) {
    return { status: "invalid" };
  }
  const quoted = ownDataProperty(value, "quoted");
  const componentValue = ownDataProperty(value, "value");
  if (typeof quoted !== "boolean" || typeof componentValue !== "string") {
    return { status: "invalid" };
  }
  if (componentValue.length > MAX_QUERY_SITE_IDENTIFIER_LENGTH) {
    return { status: "resource-limit" };
  }
  return {
    component: Object.freeze({ quoted, value: componentValue }),
    status: "valid",
  };
}

type DecoderValidation =
  | {
      readonly status: "decoded";
      readonly finalFrom: number;
      readonly finalTo: number;
      readonly prefix: SqlIdentifierComponent;
      readonly qualifier: SqlIdentifierPath;
      readonly quality: "exact" | "recovered";
    }
  | {
      readonly status: "invalid";
    }
  | {
      readonly status: "unavailable";
    }
  | {
      readonly status: "resource-limit";
      readonly resource: "identifier-path" | "identifier-segment";
    };

function validateDecoderResult(
  value: unknown,
  maximumPathDepth: number,
): DecoderValidation {
  if (!isPlainRecord(value)) {
    return { status: "invalid" };
  }
  const status = ownDataProperty(value, "status");
  if (status === "unavailable") {
    const reason = ownDataProperty(value, "reason");
    return reason === "invalid-identifier" ||
      reason === "unsupported-quote" ||
      reason === "undecodable-identifier"
      ? { status: "unavailable" }
      : { status: "invalid" };
  }
  if (status !== "decoded") {
    return { status: "invalid" };
  }
  const quality = ownDataProperty(value, "quality");
  if (quality !== "exact" && quality !== "recovered") {
    return { status: "invalid" };
  }
  const rawQualifier = ownDataProperty(value, "qualifier");
  if (!Array.isArray(rawQualifier)) {
    return { status: "invalid" };
  }
  const qualifierLength = ownDataProperty(rawQualifier, "length");
  if (
    typeof qualifierLength !== "number" ||
    !Number.isSafeInteger(qualifierLength) ||
    qualifierLength < 0
  ) {
    return { status: "invalid" };
  }
  if (qualifierLength + 1 > maximumPathDepth) {
    return { resource: "identifier-path", status: "resource-limit" };
  }
  const qualifier: SqlIdentifierComponent[] = [];
  for (let index = 0; index < qualifierLength; index += 1) {
    const component = validateDecodedComponent(
      ownDataProperty(rawQualifier, index),
    );
    if (component.status === "resource-limit") {
      return { resource: "identifier-segment", status: "resource-limit" };
    }
    if (component.status === "invalid") {
      return { status: "invalid" };
    }
    qualifier.push(component.component);
  }
  const prefix = validateDecodedComponent(
    ownDataProperty(value, "prefix"),
  );
  if (prefix.status === "resource-limit") {
    return { resource: "identifier-segment", status: "resource-limit" };
  }
  if (prefix.status === "invalid") {
    return { status: "invalid" };
  }
  const finalSegment = ownDataProperty(value, "finalSegment");
  if (!isPlainRecord(finalSegment)) {
    return { status: "invalid" };
  }
  const finalFrom = ownDataProperty(finalSegment, "from");
  const finalTo = ownDataProperty(finalSegment, "to");
  if (typeof finalFrom !== "number" || typeof finalTo !== "number") {
    return { status: "invalid" };
  }
  return {
    finalFrom,
    finalTo,
    prefix: prefix.component,
    qualifier: Object.freeze(qualifier),
    quality,
    status: "decoded",
  };
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
  maximumPathDepth: number,
  rawFrom: number,
  rawTo: number,
  position: number,
): SqlQuerySiteResult {
  if (intersectsRegion(source, rawFrom, rawTo)) {
    return unavailable("ambiguous-query-site");
  }
  const rawPath = source.originalText.slice(rawFrom, rawTo);
  let decoded: DecoderValidation;
  try {
    decoded = validateDecoderResult(
      dialect.decodeRelationPath(rawPath, position - rawFrom),
      maximumPathDepth,
    );
  } catch {
    return unavailable("ambiguous-query-site");
  }
  if (decoded.status === "resource-limit") {
    return unavailable("resource-limit", decoded.resource);
  }
  if (decoded.status === "invalid" || decoded.status === "unavailable") {
    return unavailable("ambiguous-query-site");
  }
  const finalFrom = decoded.finalFrom;
  const finalTo = decoded.finalTo;
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
    prefix: decoded.prefix,
    qualifier: decoded.qualifier,
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
  maximumPathDepth: number,
  first: Lexeme,
  position: number,
): SqlQuerySiteResult | null {
  let bareSegment = first.kind === "word";
  let expectingSegment = false;
  let pathComponents = 1;
  const rawFrom = first.from;
  let rawTo = first.to;
  while (true) {
    const next = lexer.next();
    if (lexer.resource) {
      return unavailable("resource-limit", lexer.resource);
    }
    if (next?.from === rawTo) {
      if (expectingSegment) {
        if (
          next.kind === "word" ||
          next.kind === "quoted-identifier"
        ) {
          bareSegment = next.kind === "word";
          expectingSegment = false;
          rawTo = next.to;
          continue;
        }
      }
      if (
        !expectingSegment &&
        next.kind === "punctuation" &&
        source.analysisText.charCodeAt(next.from) === 46
      ) {
        pathComponents += 1;
        if (pathComponents > maximumPathDepth) {
          return unavailable("resource-limit", "identifier-path");
        }
        expectingSegment = true;
        rawTo = next.to;
        continue;
      }
      if (
        !expectingSegment &&
        bareSegment &&
        (next.kind === "word" ||
          (next.kind === "other" &&
            (source.analysisText.charCodeAt(next.from) === 36 ||
              source.analysisText.charCodeAt(next.from) === 45 ||
              (source.analysisText.charCodeAt(next.from) >= 48 &&
                source.analysisText.charCodeAt(next.from) <= 57))))
      ) {
        rawTo = next.to;
        continue;
      }
    }
    if (expectingSegment) {
      if (position !== rawTo) {
        return unavailable("ambiguous-query-site");
      }
      expectingSegment = false;
    }
    {
      let terminator = next;
      let separated = Boolean(terminator && terminator.from > rawTo);
      while (terminator && isCommentLexeme(terminator)) {
        if (cursorIsInComment(terminator, position)) {
          return inactive("cursor-in-comment");
        }
        if (!terminator.closed) {
          return unavailable("ambiguous-query-site");
        }
        separated = true;
        terminator = lexer.next();
        if (lexer.resource) {
          return unavailable("resource-limit", lexer.resource);
        }
      }
      if (terminator?.kind === "barrier") {
        return unavailable("ambiguous-query-site");
      }
      if (terminator?.kind === "punctuation") {
        const code = source.analysisText.charCodeAt(terminator.from);
        if (code === 40) {
          return unavailable("unsupported-query-site");
        }
        if (code !== 41 && code !== 44 && code !== 59) {
          return unavailable("ambiguous-query-site");
        }
      } else if (
        terminator &&
        (terminator.kind === "string" ||
          terminator.kind === "other" ||
          !separated)
      ) {
        return unavailable("ambiguous-query-site");
      }
      if (terminator) {
        lexer.pushBack(terminator);
      }
      if (position >= rawFrom && position <= rawTo) {
        return decodeReadyPath(
          source,
          slot,
          frame,
          dialect,
          maximumPathDepth,
          rawFrom,
          rawTo,
          position,
        );
      }
      frame.state = "after-relation";
      return null;
    }
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

  let lexicalProfile: SqlLexicalProfile;
  let maximumPathDepth: number;
  try {
    lexicalProfile = dialect.lexicalProfile;
    maximumPathDepth = dialect.maximumPathDepth;
  } catch {
    return unavailable("ambiguous-query-site");
  }
  if (
    !Number.isSafeInteger(maximumPathDepth) ||
    maximumPathDepth < 1 ||
    maximumPathDepth > MAX_QUERY_SITE_PATH_COMPONENTS
  ) {
    return unavailable("ambiguous-query-site");
  }
  const lexer = new QueryLexer(
    source,
    slot.source.from,
    slot.source.to,
    lexicalProfile,
  );
  const frames: QueryFrame[] = [];
  const queryCandidates = new Set<number>([0]);
  let depth = 0;
  let sawSelect = false;
  let statementTainted = false;

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
      (source.analysisText.charCodeAt(token.from) === 41 ||
        source.analysisText.charCodeAt(token.from) === 44)
    ) {
      return readyEmpty(slot, frame, position);
    }
    const cursorInside = token.from <= position && position < token.to;
    if (isCommentLexeme(token)) {
      if (cursorIsInComment(token, position)) {
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
    if (
      token.kind === "quoted-identifier" &&
      !token.closed &&
      token.to < slot.source.to
    ) {
      return unavailable("ambiguous-query-site");
    }
    if (token.kind === "barrier") {
      statementTainted = true;
      processBarrier(frame);
      queryCandidates.delete(depth);
      continue;
    }

    const active = topFrame(frames);
    if (
      active?.state === "expect-relation" &&
      (token.kind === "word" || token.kind === "quoted-identifier")
    ) {
      if (
        token.kind === "word" &&
        wordEquals(source.analysisText, token, "lateral")
      ) {
        markUnavailable(active, "unsupported-query-site");
        continue;
      }
      const pathResult = recognizePath(
        lexer,
        source,
        slot,
        active,
        dialect,
        maximumPathDepth,
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
      queryCandidates.delete(depth);
      if (
        code === 40 &&
        punctuationFrame?.baseDepth === depth &&
        punctuationFrame.state === "join-constraint" &&
        punctuationFrame.joinPrefix !== null
      ) {
        punctuationFrame.joinPrefix = null;
      }
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
        let poppedTaint = false;
        while (
          frames.length > 0 &&
          (topFrame(frames)?.baseDepth ?? -1) >= depth
        ) {
          const poppedFrame = frames.pop();
          if (poppedFrame?.tainted) {
            poppedTaint = true;
          }
        }
        if (poppedTaint) {
          const enclosingFrame = topFrame(frames);
          if (enclosingFrame) {
            enclosingFrame.tainted = true;
          }
        }
        depth = Math.max(0, depth - 1);
      } else if (code === 44) {
        const commaFrame = topFrame(frames);
        if (
          commaFrame?.baseDepth === depth &&
          (commaFrame.state === "after-relation" ||
            commaFrame.state === "after-alias" ||
            (commaFrame.state === "join-constraint" &&
              commaFrame.joinConstraintSeen))
        ) {
          if (commaFrame.joinPrefix !== null) {
            markUnavailable(commaFrame, "ambiguous-query-site");
          } else {
            commaFrame.anchor = "comma";
            commaFrame.joinConstraintAllowed = false;
            commaFrame.joinConstraintSeen = false;
            commaFrame.state = "expect-relation";
          }
        }
      } else if (
        punctuationFrame?.baseDepth === depth &&
        (punctuationFrame.state === "after-relation" ||
          punctuationFrame.state === "after-alias")
      ) {
        markUnavailable(punctuationFrame, "ambiguous-query-site");
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
          frames.push(createFrame(depth, statementTainted));
          sawSelect = true;
          if (token.to === position) {
            return inactive("not-relation-position");
          }
          continue;
        }
      }
      const activeFrame = topFrame(frames);
      let openedRelation = false;
      if (activeFrame?.baseDepth === depth) {
        const previousState = activeFrame.state;
        processFrameWord(
          activeFrame,
          wordValue(source.analysisText, token),
        );
        openedRelation =
          previousState !== "expect-relation" &&
          activeFrame.state === "expect-relation";
      }
      if (openedRelation && token.to === position) {
        return inactive("not-relation-position");
      }
    } else if (token.kind === "quoted-identifier") {
      queryCandidates.delete(depth);
      const activeFrame = topFrame(frames);
      if (
        activeFrame?.baseDepth === depth &&
        (activeFrame.state === "after-relation" ||
          activeFrame.state === "expect-alias")
      ) {
        activeFrame.state = "after-alias";
      } else if (
        activeFrame?.baseDepth === depth &&
        activeFrame.state === "after-alias"
      ) {
        markUnavailable(activeFrame, "ambiguous-query-site");
      }
    } else if (queryCandidates.has(depth)) {
      queryCandidates.delete(depth);
    }
    const remainingFrame = topFrame(frames);
    if (
      (token.kind === "other" || token.kind === "string") &&
      remainingFrame?.baseDepth === depth &&
      remainingFrame.state === "join-constraint" &&
      remainingFrame.joinPrefix !== null
    ) {
      remainingFrame.joinPrefix = null;
    }
    if (
      (token.kind === "other" || token.kind === "string") &&
      remainingFrame?.baseDepth === depth &&
      (remainingFrame.state === "after-relation" ||
        remainingFrame.state === "after-alias")
    ) {
      markUnavailable(remainingFrame, "ambiguous-query-site");
    }
    if (
      token.kind === "other" &&
      remainingFrame?.baseDepth === depth &&
      remainingFrame.state === "join-constraint" &&
      (source.analysisText.charCodeAt(token.from) === 91 ||
        source.analysisText.charCodeAt(token.from) === 93)
    ) {
      markUnavailable(remainingFrame, "unsupported-query-site");
    }
    if (token.to === position) {
      return resultAtGap(slot, topFrame(frames), position, sawSelect);
    }
  }
}
