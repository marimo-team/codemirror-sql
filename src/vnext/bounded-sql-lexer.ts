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

export const MAX_BOUNDED_SQL_LEXEMES = 16_384;

export type BoundedSqlLexemeKind =
  | "barrier"
  | "comment"
  | "line-comment"
  | "other"
  | "punctuation"
  | "quoted-identifier"
  | "string"
  | "word";

export interface BoundedSqlLexeme {
  readonly closed: boolean;
  readonly from: number;
  readonly kind: BoundedSqlLexemeKind;
  readonly to: number;
}

export type BoundedSqlLexerResource =
  | "dollar-quote-delimiter"
  | "lexical-token";

function findSqlRegionAtOrAfter(
  source: SqlSourceSnapshot,
  position: number,
): number {
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

export class BoundedSqlLexer {
  readonly #profile: SqlLexicalProfile;
  readonly #source: SqlSourceSnapshot;
  readonly #to: number;
  #cursor: number;
  #lexemeCount = 0;
  #pushed: BoundedSqlLexeme | null = null;
  #regionIndex: number;
  resource: BoundedSqlLexerResource | null = null;

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
    this.#regionIndex = findSqlRegionAtOrAfter(source, from);
  }

  next(): BoundedSqlLexeme | null {
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
            this.resource = "dollar-quote-delimiter";
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
        const quotedIdentifier =
          code === 34 && !this.#profile.bigQueryStrings;
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
          const length = sqlIdentifierContinueLengthAt(
            text,
            this.#cursor,
          );
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

  pushBack(lexeme: BoundedSqlLexeme): void {
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

  #record(lexeme: BoundedSqlLexeme): BoundedSqlLexeme | null {
    this.#lexemeCount += 1;
    if (this.#lexemeCount > MAX_BOUNDED_SQL_LEXEMES) {
      this.resource = "lexical-token";
      return null;
    }
    return lexeme;
  }
}
