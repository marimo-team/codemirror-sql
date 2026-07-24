const MAX_DOLLAR_QUOTE_DELIMITER_LENGTH = 256;

type SqlSingleQuoteBackslash = "always" | "e-prefix" | "never";
type SqlProceduralGuards = "bigquery" | "none" | "postgresql";

export interface SqlLexicalProfile {
  readonly backtickQuotedIdentifiers: boolean;
  readonly bigQueryStrings: boolean;
  readonly dollarQuotedStrings: boolean;
  readonly hashLineComments: boolean;
  readonly nestedBlockComments: boolean;
  readonly proceduralGuards: SqlProceduralGuards;
  readonly singleQuoteBackslash: SqlSingleQuoteBackslash;
}

export const POSTGRESQL_SQL_LEXICAL_PROFILE: SqlLexicalProfile = Object.freeze({
  backtickQuotedIdentifiers: false,
  bigQueryStrings: false,
  dollarQuotedStrings: true,
  hashLineComments: false,
  nestedBlockComments: true,
  proceduralGuards: "postgresql",
  singleQuoteBackslash: "e-prefix",
});

export const DUCKDB_SQL_LEXICAL_PROFILE: SqlLexicalProfile = Object.freeze({
  backtickQuotedIdentifiers: false,
  bigQueryStrings: false,
  dollarQuotedStrings: true,
  hashLineComments: false,
  nestedBlockComments: true,
  proceduralGuards: "none",
  singleQuoteBackslash: "e-prefix",
});

export const BIGQUERY_SQL_LEXICAL_PROFILE: SqlLexicalProfile = Object.freeze({
  backtickQuotedIdentifiers: true,
  bigQueryStrings: true,
  dollarQuotedStrings: false,
  hashLineComments: true,
  nestedBlockComments: false,
  proceduralGuards: "bigquery",
  singleQuoteBackslash: "always",
});

export const DREMIO_SQL_LEXICAL_PROFILE: SqlLexicalProfile = Object.freeze({
  backtickQuotedIdentifiers: false,
  bigQueryStrings: false,
  dollarQuotedStrings: false,
  hashLineComments: false,
  nestedBlockComments: false,
  proceduralGuards: "none",
  singleQuoteBackslash: "never",
});

function isAsciiIdentifierStart(code: number): boolean {
  return (
    code === 95 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiIdentifierContinue(code: number): boolean {
  return isAsciiIdentifierStart(code) || (code >= 48 && code <= 57);
}

function codePointLengthAt(text: string, index: number): 0 | 1 | 2 {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return 0;
  }
  return codePoint > 0xffff ? 2 : 1;
}

export function sqlIdentifierStartLengthAt(
  text: string,
  index: number,
): 0 | 1 | 2 {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) {
    return isAsciiIdentifierStart(code) ? 1 : 0;
  }
  return codePointLengthAt(text, index);
}

export function sqlIdentifierContinueLengthAt(
  text: string,
  index: number,
): 0 | 1 | 2 {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) {
    return isAsciiIdentifierContinue(code) ? 1 : 0;
  }
  return codePointLengthAt(text, index);
}

function previousCodePointIndex(text: string, index: number): number {
  if (index <= 0) {
    return -1;
  }
  const last = text.charCodeAt(index - 1);
  if (
    last >= 0xdc00 &&
    last <= 0xdfff &&
    index >= 2
  ) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) {
      return index - 2;
    }
  }
  return index - 1;
}

function hasSqlIdentifierBefore(text: string, index: number): boolean {
  const previous = previousCodePointIndex(text, index);
  if (previous < 0) {
    return false;
  }
  return (
    text.charCodeAt(previous) === 36 ||
    sqlIdentifierContinueLengthAt(text, previous) > 0
  );
}

export function isSqlWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32
  );
}

function hasPrefixAtTokenBoundary(
  text: string,
  quoteAt: number,
  prefix: string,
): boolean {
  const prefixFrom = quoteAt - prefix.length;
  if (prefixFrom < 0) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    const actual = text.charCodeAt(prefixFrom + index) | 32;
    if (actual !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return prefixFrom === 0 || !hasSqlIdentifierBefore(text, prefixFrom);
}

export function hasEscapeStringPrefix(text: string, quoteAt: number): boolean {
  return hasPrefixAtTokenBoundary(text, quoteAt, "e");
}

export function isBigQueryRawString(text: string, quoteAt: number): boolean {
  return (
    hasPrefixAtTokenBoundary(text, quoteAt, "r") ||
    hasPrefixAtTokenBoundary(text, quoteAt, "br") ||
    hasPrefixAtTokenBoundary(text, quoteAt, "rb")
  );
}

export interface SqlQuoteScanResult {
  readonly closed: boolean;
  readonly to: number;
}

export function scanSqlQuoted(
  text: string,
  from: number,
  limit: number,
  quote: number,
  quoteLength: 1 | 3,
  backslashEscapes: boolean,
  doubledQuoteEscapes: boolean,
  stopAtLineBreak: boolean,
): SqlQuoteScanResult {
  let cursor = from + quoteLength;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    if (stopAtLineBreak && (code === 10 || code === 13)) {
      return { closed: false, to: limit };
    }
    if (backslashEscapes && code === 92) {
      const escapedCode = text.charCodeAt(cursor + 1);
      if (
        stopAtLineBreak &&
        (escapedCode === 10 || escapedCode === 13)
      ) {
        return { closed: false, to: limit };
      }
      cursor += Math.min(2, limit - cursor);
      continue;
    }
    if (code !== quote) {
      cursor += 1;
      continue;
    }
    if (quoteLength === 3) {
      if (
        cursor + 2 < limit &&
        text.charCodeAt(cursor + 1) === quote &&
        text.charCodeAt(cursor + 2) === quote
      ) {
        return { closed: true, to: cursor + 3 };
      }
      cursor += 1;
      continue;
    }
    if (
      doubledQuoteEscapes &&
      cursor + 1 < limit &&
      text.charCodeAt(cursor + 1) === quote
    ) {
      cursor += 2;
      continue;
    }
    return { closed: true, to: cursor + 1 };
  }
  return { closed: false, to: limit };
}

export interface SqlBlockCommentScanResult {
  readonly closed: boolean;
  readonly to: number;
}

export function scanSqlBlockComment(
  text: string,
  from: number,
  limit: number,
  nested: boolean,
): SqlBlockCommentScanResult {
  let cursor = from + 2;
  let depth = 1;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    const next = text.charCodeAt(cursor + 1);
    if (nested && cursor + 1 < limit && code === 47 && next === 42) {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (cursor + 1 < limit && code === 42 && next === 47) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        return { closed: true, to: cursor };
      }
      continue;
    }
    cursor += 1;
  }
  return { closed: false, to: limit };
}

export interface SqlDollarQuoteScanResult {
  readonly closed: boolean;
  readonly delimiterTooLong: boolean;
  readonly to: number;
}

function findDollarQuoteClose(
  text: string,
  delimiter: string,
  from: number,
  limit: number,
): number {
  if (limit === text.length) {
    return text.indexOf(delimiter, from);
  }
  const finalCandidate = limit - delimiter.length;
  for (let candidate = from; candidate <= finalCandidate; candidate += 1) {
    if (text.charCodeAt(candidate) === 36 && text.startsWith(delimiter, candidate)) {
      return candidate;
    }
  }
  return -1;
}

export function scanSqlDollarQuote(
  text: string,
  from: number,
  limit: number,
): SqlDollarQuoteScanResult | null {
  if (hasSqlIdentifierBefore(text, from)) {
    return null;
  }
  const first = text.charCodeAt(from + 1);
  let cursor = from + 1;
  let delimiterTooLong = false;
  if (first !== 36) {
    const firstLength = sqlIdentifierStartLengthAt(text, cursor);
    if (firstLength === 0) {
      return null;
    }
    cursor += firstLength;
    while (cursor < limit) {
      const continueLength = sqlIdentifierContinueLengthAt(text, cursor);
      if (continueLength === 0) {
        break;
      }
      if (cursor - from + 1 > MAX_DOLLAR_QUOTE_DELIMITER_LENGTH) {
        delimiterTooLong = true;
      }
      cursor += continueLength;
    }
    if (cursor >= limit || text.charCodeAt(cursor) !== 36) {
      return null;
    }
    if (delimiterTooLong) {
      return {
        closed: false,
        delimiterTooLong: true,
        to: limit,
      };
    }
  }
  const delimiterTo = cursor + 1;
  const delimiter = text.slice(from, delimiterTo);
  const closeAt = findDollarQuoteClose(text, delimiter, delimiterTo, limit);
  if (closeAt < 0) {
    return {
      closed: false,
      delimiterTooLong: false,
      to: limit,
    };
  }
  return {
    closed: true,
    delimiterTooLong: false,
    to: closeAt + delimiter.length,
  };
}
