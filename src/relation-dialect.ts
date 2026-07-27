import {
  MAX_CTE_DECLARATIONS,
  MAX_CTE_QUOTED_IDENTIFIER_LENGTH,
  type SqlCteIdentifierResult,
  type SqlCteLayoutDialect,
} from "./cte-layout.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  sqlIdentifierContinueLengthAt,
  sqlIdentifierStartLengthAt,
  type SqlLexicalProfile,
} from "./lexical.js";
import {
  MAX_QUERY_SITE_IDENTIFIER_LENGTH,
  MAX_QUERY_SITE_PATH_COMPONENTS,
  type SqlDecodedQueryPath,
  type SqlQuerySiteDialect,
} from "./query-site.js";
import { isSqlRelationReservedWord } from "./relation-reserved-words.js";
import {
  registerSqlRelationDialectRuntime,
} from "./relation-runtime-auth.js";
import type {
  SqlCteIdentifierComparison,
  SqlCteIdentifierPrefixMatch,
  SqlIdentifierDecodeResult,
  SqlRelationCompletionDialectRuntime,
  SqlRenderedRelationPath,
} from "./relation-completion-types.js";
import type { SqlIdentifierComponent } from "./types.js";

export interface SqlRelationDialectRuntime {
  readonly completion: SqlRelationCompletionDialectRuntime;
  readonly cteLayout: SqlCteLayoutDialect;
  readonly id: SqlRelationDialectId;
  readonly querySite: SqlQuerySiteDialect;
}

export type SqlRelationDialectId =
  | "bigquery"
  | "dremio"
  | "duckdb"
  | "postgresql";

interface RelationDialectSpec {
  readonly cteGrammar: SqlCteLayoutDialect["grammar"];
  readonly kind: SqlRelationDialectId;
  readonly lexicalProfile: SqlLexicalProfile;
  readonly maximumPathDepth: number;
  readonly supportsNaturalJoin: boolean;
}

interface RawSegment {
  readonly closed: boolean;
  readonly from: number;
  readonly quoted: boolean;
  readonly to: number;
}

const MAX_IDENTIFIER_LENGTH = MAX_QUERY_SITE_IDENTIFIER_LENGTH;
const MAX_BIGQUERY_QUOTED_IDENTIFIER_RAW_LENGTH =
  MAX_CTE_QUOTED_IDENTIFIER_LENGTH;
const MAX_STANDARD_QUOTED_IDENTIFIER_RAW_LENGTH =
  MAX_IDENTIFIER_LENGTH * 2 + 2;
const DREMIO_BARE_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const INVALID_IDENTIFIER = Object.freeze({
  reason: "invalid-identifier" as const,
  status: "unavailable" as const,
});
const UNSUPPORTED_IDENTIFIER = Object.freeze({
  status: "unsupported" as const,
});
const BIGQUERY_IMPLICIT_ALIAS_CONTROL_WORDS = Object.freeze([
  "match_recognize",
  "pivot",
  "unpivot",
]);

function asciiFoldCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function identifierCodeEquals(
  left: string,
  right: string,
  foldLeft: boolean,
  foldRight: boolean,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (
      (foldLeft ? asciiFoldCode(leftCode) : leftCode) !==
      (foldRight ? asciiFoldCode(rightCode) : rightCode)
    ) {
      return false;
    }
  }
  return true;
}

function identifierPrefixMatches(
  candidate: string,
  prefix: string,
  foldCandidate: boolean,
  foldPrefix: boolean,
): boolean {
  if (prefix.length > candidate.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    const candidateCode = candidate.charCodeAt(index);
    const prefixCode = prefix.charCodeAt(index);
    if (
      (foldCandidate ? asciiFoldCode(candidateCode) : candidateCode) !==
      (foldPrefix ? asciiFoldCode(prefixCode) : prefixCode)
    ) {
      return false;
    }
  }
  return true;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function isControlWord(
  value: string,
  words: readonly string[],
): boolean {
  if (!isAscii(value)) {
    return false;
  }
  for (const word of words) {
    if (identifierCodeEquals(value, word, true, false)) {
      return true;
    }
  }
  return false;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isBareIdentifier(
  value: string,
  allowDollar: boolean,
): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !isWellFormed(value)
  ) {
    return false;
  }
  let cursor = sqlIdentifierStartLengthAt(value, 0);
  if (cursor === 0) {
    return false;
  }
  while (cursor < value.length) {
    if (allowDollar && value.charCodeAt(cursor) === 36) {
      cursor += 1;
      continue;
    }
    const length = sqlIdentifierContinueLengthAt(value, cursor);
    if (length === 0) {
      return false;
    }
    cursor += length;
  }
  return true;
}

function isBigQueryDashedIdentifier(value: string): boolean {
  if (!isAscii(value)) {
    return false;
  }
  const parts = value.split("-");
  const first = parts[0];
  if (!first || !isBareIdentifier(first, false)) {
    return false;
  }
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (
      !part ||
      (!/^\d+$/.test(part) && !isBareIdentifier(part, false))
    ) {
      return false;
    }
  }
  return parts.length > 1;
}

function isDremioBareIdentifier(value: string): boolean {
  return (
    isBareIdentifier(value, false) &&
    DREMIO_BARE_IDENTIFIER.test(value)
  );
}

function freezeComponent(
  value: string,
  quoted: boolean,
): SqlIdentifierComponent {
  return Object.freeze({ quoted, value });
}

function decodedIdentifier(
  value: string,
  quoted: boolean,
  quality: "exact" | "recovered",
): SqlIdentifierDecodeResult {
  return Object.freeze({
    component: freezeComponent(value, quoted),
    quality,
    status: "decoded",
  });
}

function decodeDoubleQuoted(
  token: string,
  mode: "complete" | "completion-prefix",
  kind: Exclude<SqlRelationDialectId, "bigquery">,
): SqlIdentifierDecodeResult {
  if (token.length > MAX_STANDARD_QUOTED_IDENTIFIER_RAW_LENGTH) {
    return INVALID_IDENTIFIER;
  }
  if (token.length === 0 && mode === "completion-prefix") {
    return decodedIdentifier("", false, "exact");
  }
  if (!token.startsWith("\"")) {
    if (
      !(kind === "dremio"
        ? isDremioBareIdentifier(token)
        : isBareIdentifier(token, kind === "postgresql")) ||
      isSqlRelationReservedWord(kind, token)
    ) {
      return INVALID_IDENTIFIER;
    }
    return decodedIdentifier(token, false, "exact");
  }

  const closed = token.length > 1 && token.endsWith("\"");
  if (!closed && mode === "complete") {
    return INVALID_IDENTIFIER;
  }
  const contentTo = closed ? token.length - 1 : token.length;
  let output = "";
  for (let cursor = 1; cursor < contentTo; cursor += 1) {
    const code = token.charCodeAt(cursor);
    if (code === 0) {
      return INVALID_IDENTIFIER;
    }
    if (code !== 34) {
      output += token[cursor];
      if (output.length > MAX_IDENTIFIER_LENGTH) {
        return INVALID_IDENTIFIER;
      }
      continue;
    }
    if (
      cursor + 1 >= contentTo ||
      token.charCodeAt(cursor + 1) !== 34
    ) {
      return INVALID_IDENTIFIER;
    }
    output += "\"";
    if (output.length > MAX_IDENTIFIER_LENGTH) {
      return INVALID_IDENTIFIER;
    }
    cursor += 1;
  }
  if (
    (output.length === 0 &&
      !(mode === "completion-prefix" && !closed)) ||
    output.length > MAX_IDENTIFIER_LENGTH ||
    !isWellFormed(output)
  ) {
    return INVALID_IDENTIFIER;
  }
  return decodedIdentifier(
    output,
    true,
    closed ? "exact" : "recovered",
  );
}

function digitValue(code: number, radix: number): number {
  if (code >= 48 && code <= 57) {
    const value = code - 48;
    return value < radix ? value : -1;
  }
  if (radix === 16 && code >= 65 && code <= 70) {
    return code - 55;
  }
  if (radix === 16 && code >= 97 && code <= 102) {
    return code - 87;
  }
  return -1;
}

function decodeDigits(
  text: string,
  from: number,
  length: number,
  radix: number,
): number | null {
  if (from + length > text.length) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    const digit = digitValue(text.charCodeAt(from + index), radix);
    if (digit < 0) {
      return null;
    }
    value = value * radix + digit;
  }
  return value;
}

const BIGQUERY_SIMPLE_ESCAPES: Readonly<Record<string, string>> =
  Object.freeze({
    "\"": "\"",
    "'": "'",
    "?": "?",
    "\\": "\\",
    "`": "`",
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  });

function decodeBigQueryContent(content: string): string | null {
  let output = "";
  for (let cursor = 0; cursor < content.length; cursor += 1) {
    const code = content.charCodeAt(cursor);
    if (code === 0 || code === 10 || code === 13) {
      return null;
    }
    if (code !== 92) {
      output += content[cursor];
      if (output.length > MAX_IDENTIFIER_LENGTH) {
        return null;
      }
      continue;
    }
    const escape = content[cursor + 1];
    if (escape === undefined) {
      return null;
    }
    const simple = BIGQUERY_SIMPLE_ESCAPES[escape];
    if (simple !== undefined) {
      output += simple;
      if (output.length > MAX_IDENTIFIER_LENGTH) {
        return null;
      }
      cursor += 1;
      continue;
    }
    let digitsFrom = cursor + 1;
    let digitsLength = 0;
    let radix = 16;
    if (escape >= "0" && escape <= "7") {
      digitsLength = 3;
      radix = 8;
    } else if (escape === "x" || escape === "X") {
      digitsFrom += 1;
      digitsLength = 2;
    } else if (escape === "u") {
      digitsFrom += 1;
      digitsLength = 4;
    } else if (escape === "U") {
      digitsFrom += 1;
      digitsLength = 8;
    } else {
      return null;
    }
    const value = decodeDigits(
      content,
      digitsFrom,
      digitsLength,
      radix,
    );
    if (
      value === null ||
      value === 0 ||
      value > 0x10ffff ||
      (value >= 0xd800 && value <= 0xdfff)
    ) {
      return null;
    }
    output += String.fromCodePoint(value);
    if (output.length > MAX_IDENTIFIER_LENGTH) {
      return null;
    }
    cursor = digitsFrom + digitsLength - 1;
  }
  return output.length <= MAX_IDENTIFIER_LENGTH &&
    isWellFormed(output)
    ? output
    : null;
}

function decodeBigQueryIdentifier(
  token: string,
  mode: "complete" | "completion-prefix",
): SqlIdentifierDecodeResult {
  if (token.length > MAX_BIGQUERY_QUOTED_IDENTIFIER_RAW_LENGTH) {
    return INVALID_IDENTIFIER;
  }
  if (token.length === 0 && mode === "completion-prefix") {
    return decodedIdentifier("", false, "exact");
  }
  if (!token.startsWith("`")) {
    if (
      !isAscii(token) ||
      !isBareIdentifier(token, false) ||
      isSqlRelationReservedWord("bigquery", token)
    ) {
      return INVALID_IDENTIFIER;
    }
    return decodedIdentifier(token, false, "exact");
  }
  const closed =
    token.length > 1 &&
    token.endsWith("`") &&
    !isEscapedAt(token, token.length - 1);
  if (!closed && mode === "complete") {
    return INVALID_IDENTIFIER;
  }
  const value = decodeBigQueryContent(
    token.slice(1, closed ? -1 : undefined),
  );
  if (
    value === null ||
    (value.length === 0 &&
      !(mode === "completion-prefix" && !closed))
  ) {
    return INVALID_IDENTIFIER;
  }
  return decodedIdentifier(
    value,
    true,
    closed ? "exact" : "recovered",
  );
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text.charCodeAt(cursor) === 92;
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function splitQuotedPath(
  rawPath: string,
  quote: "\"" | "`",
): readonly RawSegment[] | null {
  const output: RawSegment[] = [];
  let segmentFrom = 0;
  let cursor = 0;
  while (cursor <= rawPath.length) {
    if (cursor === rawPath.length) {
      output.push({
        closed: true,
        from: segmentFrom,
        quoted: false,
        to: cursor,
      });
      break;
    }
    if (rawPath[cursor] === quote && cursor === segmentFrom) {
      const quotedFrom = cursor;
      cursor += 1;
      let closed = false;
      while (cursor < rawPath.length) {
        if (rawPath[cursor] !== quote) {
          if (quote === "`" && rawPath[cursor] === "\\") {
            cursor += Math.min(2, rawPath.length - cursor);
          } else {
            cursor += 1;
          }
          continue;
        }
        if (
          quote === "\"" &&
          rawPath[cursor + 1] === "\""
        ) {
          cursor += 2;
          continue;
        }
        closed = true;
        cursor += 1;
        break;
      }
      if (cursor < rawPath.length && rawPath[cursor] !== ".") {
        return null;
      }
      output.push({
        closed,
        from: quotedFrom,
        quoted: true,
        to: cursor,
      });
      if (cursor === rawPath.length) {
        break;
      }
      segmentFrom = cursor + 1;
      cursor = segmentFrom;
      continue;
    }
    if (rawPath[cursor] === quote) {
      return null;
    }
    if (rawPath[cursor] === ".") {
      output.push({
        closed: true,
        from: segmentFrom,
        quoted: false,
        to: cursor,
      });
      segmentFrom = cursor + 1;
    }
    cursor += 1;
  }
  return output;
}

function decodePathSegment(
  rawPath: string,
  segment: RawSegment,
  decodeIdentifier: SqlRelationCompletionDialectRuntime["decodeIdentifier"],
): SqlIdentifierComponent | null {
  if (!segment.closed || segment.from === segment.to) {
    return null;
  }
  const result = decodeIdentifier(
    rawPath.slice(segment.from, segment.to),
    "complete",
  );
  return result.status === "decoded" ? result.component : null;
}

function freezeDecodedPath(
  qualifier: SqlIdentifierComponent[],
  prefix: SqlIdentifierComponent,
  finalFrom: number,
  finalTo: number,
  quality: "exact" | "recovered",
): SqlDecodedQueryPath {
  return Object.freeze({
    finalSegment: Object.freeze({ from: finalFrom, to: finalTo }),
    prefix,
    qualifier: Object.freeze(qualifier),
    quality,
    status: "decoded",
  });
}

function decodeSegmentedPath(
  rawPath: string,
  cursorOffset: number,
  maximumPathDepth: number,
  quote: "\"" | "`",
  decodeIdentifier: SqlRelationCompletionDialectRuntime["decodeIdentifier"],
  kind: SqlRelationDialectId,
): SqlDecodedQueryPath {
  if (
    typeof rawPath !== "string" ||
    !Number.isSafeInteger(cursorOffset) ||
    cursorOffset < 0 ||
    cursorOffset > rawPath.length
  ) {
    return INVALID_IDENTIFIER;
  }
  const segments = splitQuotedPath(rawPath, quote);
  if (
    !segments ||
    segments.length === 0 ||
    segments.length > maximumPathDepth
  ) {
    return INVALID_IDENTIFIER;
  }
  const final = segments[segments.length - 1];
  if (
    !final ||
    cursorOffset < final.from ||
    cursorOffset > final.to
  ) {
    return INVALID_IDENTIFIER;
  }
  const qualifier: SqlIdentifierComponent[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) {
      return INVALID_IDENTIFIER;
    }
    const component =
      kind === "bigquery" && !segment.quoted
        ? decodeBigQueryBarePathSegment(
            rawPath.slice(segment.from, segment.to),
            index,
          )
        : decodePathSegment(rawPath, segment, decodeIdentifier);
    if (!component) {
      return INVALID_IDENTIFIER;
    }
    qualifier.push(component);
  }

  let prefixToken = rawPath.slice(final.from, cursorOffset);
  if (final.quoted) {
    if (prefixToken.length === 0) {
      return freezeDecodedPath(
        qualifier,
        freezeComponent("", true),
        final.from,
        final.to,
        "exact",
      );
    }
    if (final.closed && !prefixToken.endsWith(quote)) {
      prefixToken += quote;
    }
  }
  let prefix: SqlIdentifierComponent | null = null;
  let quality: "exact" | "recovered" =
    final.quoted && !final.closed ? "recovered" : "exact";
  if (
    kind === "bigquery" &&
    !final.quoted &&
    prefixToken.length > 0
  ) {
    prefix = decodeBigQueryBarePathSegment(
      prefixToken,
      segments.length - 1,
    );
  } else {
    const decoded = decodeIdentifier(
      prefixToken,
      "completion-prefix",
    );
    if (decoded.status === "decoded") {
      prefix = decoded.component;
      if (decoded.quality === "recovered") {
        quality = "recovered";
      }
    }
  }
  return prefix
    ? freezeDecodedPath(
        qualifier,
        prefix,
        final.from,
        final.to,
        quality,
      )
    : INVALID_IDENTIFIER;
}

function decodeBigQueryBarePathSegment(
  value: string,
  index: number,
): SqlIdentifierComponent | null {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !isAscii(value) ||
    !isWellFormed(value)
  ) {
    return null;
  }
  if (value.includes("-")) {
    return index === 0 && isBigQueryDashedIdentifier(value)
      ? freezeComponent(value, false)
      : null;
  }
  if (
    !isBareIdentifier(value, false) ||
    (index === 0 &&
      isSqlRelationReservedWord("bigquery", value))
  ) {
    return null;
  }
  return freezeComponent(value, false);
}

function splitBigQueryWholePath(
  content: string,
): readonly { readonly from: number; readonly to: number }[] | null {
  const output: { from: number; to: number }[] = [];
  let from = 0;
  for (let cursor = 0; cursor < content.length; cursor += 1) {
    if (content[cursor] === "\\") {
      const escape = content[cursor + 1];
      if (escape === undefined) {
        return null;
      }
      if (escape >= "0" && escape <= "7") {
        cursor += 3;
      } else if (escape === "x" || escape === "X") {
        cursor += 3;
      } else if (escape === "u") {
        cursor += 5;
      } else if (escape === "U") {
        cursor += 9;
      } else {
        cursor += 1;
      }
      if (cursor >= content.length) {
        return null;
      }
      continue;
    }
    if (content[cursor] === ".") {
      if (cursor === from) {
        return null;
      }
      output.push({ from, to: cursor });
      from = cursor + 1;
    }
  }
  if (from === content.length) {
    return null;
  }
  output.push({ from, to: content.length });
  return output;
}

function decodeBigQueryWholePath(
  rawPath: string,
  cursorOffset: number,
): SqlDecodedQueryPath | null {
  if (!rawPath.startsWith("`")) {
    return null;
  }
  let closingAt = -1;
  for (let cursor = 1; cursor < rawPath.length; cursor += 1) {
    if (rawPath[cursor] === "\\") {
      cursor += 1;
    } else if (rawPath[cursor] === "`") {
      closingAt = cursor;
      break;
    }
  }
  if (closingAt >= 0 && closingAt !== rawPath.length - 1) {
    return null;
  }
  const closed = closingAt === rawPath.length - 1;
  const contentTo = closed ? rawPath.length - 1 : rawPath.length;
  const content = rawPath.slice(1, contentTo);
  if (content.length === 0 && !closed) {
    return freezeDecodedPath(
      [],
      freezeComponent("", true),
      1,
      rawPath.length,
      "recovered",
    );
  }
  const parts = splitBigQueryWholePath(content);
  if (
    !parts ||
    parts.length > 3 ||
    !Number.isSafeInteger(cursorOffset) ||
    cursorOffset < 1 ||
    cursorOffset > rawPath.length
  ) {
    return INVALID_IDENTIFIER;
  }
  const final = parts[parts.length - 1];
  if (!final) {
    return INVALID_IDENTIFIER;
  }
  const finalFrom = final.from + 1;
  const finalContentTo = final.to + 1;
  const maximumCursor = closed ? rawPath.length - 1 : rawPath.length;
  const contentCursor = Math.min(cursorOffset, maximumCursor);
  if (contentCursor < finalFrom || contentCursor > finalContentTo) {
    return INVALID_IDENTIFIER;
  }
  const qualifier: SqlIdentifierComponent[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) {
      return INVALID_IDENTIFIER;
    }
    const value = decodeBigQueryContent(
      content.slice(part.from, part.to),
    );
    if (!value) {
      return INVALID_IDENTIFIER;
    }
    qualifier.push(freezeComponent(value, true));
  }
  const prefixValue = decodeBigQueryContent(
    rawPath.slice(finalFrom, contentCursor),
  );
  if (prefixValue === null) {
    return INVALID_IDENTIFIER;
  }
  return freezeDecodedPath(
    qualifier,
    freezeComponent(prefixValue, true),
    finalFrom,
    rawPath.length,
    closed ? "exact" : "recovered",
  );
}

function createPathDecoder(
  spec: RelationDialectSpec,
  decodeIdentifier: SqlRelationCompletionDialectRuntime["decodeIdentifier"],
): SqlQuerySiteDialect["decodeRelationPath"] {
  const maximumRawIdentifierLength =
    spec.kind === "bigquery"
      ? MAX_BIGQUERY_QUOTED_IDENTIFIER_RAW_LENGTH
      : MAX_STANDARD_QUOTED_IDENTIFIER_RAW_LENGTH;
  const maximumRawPathLength =
    spec.maximumPathDepth * (maximumRawIdentifierLength + 1);
  return (rawPath, cursorOffset) => {
    try {
      if (
        typeof rawPath !== "string" ||
        rawPath.length > maximumRawPathLength ||
        !Number.isSafeInteger(cursorOffset)
      ) {
        return INVALID_IDENTIFIER;
      }
      if (spec.kind === "bigquery") {
        const whole = decodeBigQueryWholePath(rawPath, cursorOffset);
        if (whole) {
          return whole;
        }
      }
      return decodeSegmentedPath(
        rawPath,
        cursorOffset,
        spec.maximumPathDepth,
        spec.kind === "bigquery" ? "`" : "\"",
        decodeIdentifier,
        spec.kind,
      );
    } catch {
      return INVALID_IDENTIFIER;
    }
  };
}

function createQueryClassifier(
  kind: SqlRelationDialectId,
  decodeIdentifier: SqlRelationCompletionDialectRuntime["decodeIdentifier"],
): SqlQuerySiteDialect["classifyIdentifierToken"] {
  return (rawIdentifier, quoted, role) => {
    if (
      typeof rawIdentifier !== "string" ||
      typeof quoted !== "boolean" ||
      (role !== "explicit-alias" &&
        role !== "implicit-alias" &&
        role !== "using-column") ||
      (kind === "bigquery" &&
        role === "implicit-alias" &&
        !quoted &&
        isControlWord(
          rawIdentifier,
          BIGQUERY_IMPLICIT_ALIAS_CONTROL_WORDS,
        ))
    ) {
      return UNSUPPORTED_IDENTIFIER;
    }
    const result = decodeIdentifier(rawIdentifier, "complete");
    if (
      result.status !== "decoded" ||
      result.component.quoted !== quoted ||
      result.component.value.length === 0
    ) {
      return UNSUPPORTED_IDENTIFIER;
    }
    return Object.freeze({
      status: "identifier" as const,
      value: result.component.value,
    });
  };
}

function createCteClassifier(
  decodeIdentifier: SqlRelationCompletionDialectRuntime["decodeIdentifier"],
): SqlCteLayoutDialect["classifyIdentifierToken"] {
  return (rawIdentifier, quoted, role): SqlCteIdentifierResult => {
    if (
      typeof rawIdentifier !== "string" ||
      typeof quoted !== "boolean" ||
      (role !== "cte-column" && role !== "cte-name")
    ) {
      return UNSUPPORTED_IDENTIFIER;
    }
    const result = decodeIdentifier(rawIdentifier, "complete");
    if (
      result.status !== "decoded" ||
      result.component.quoted !== quoted ||
      result.component.value.length === 0
    ) {
      return UNSUPPORTED_IDENTIFIER;
    }
    return Object.freeze({
      status: "identifier" as const,
      value: Object.freeze({ component: result.component }),
    });
  };
}

function postgresComparison(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): SqlCteIdentifierComparison {
  if (
    left === null ||
    typeof left !== "object" ||
    right === null ||
    typeof right !== "object"
  ) {
    return "unknown";
  }
  const leftQuoted = left.quoted;
  const leftValue = left.value;
  const rightQuoted = right.quoted;
  const rightValue = right.value;
  if (
    !validComparisonValue(leftValue, leftQuoted) ||
    !validComparisonValue(rightValue, rightQuoted)
  ) {
    return "unknown";
  }
  if (leftQuoted === rightQuoted && leftValue === rightValue) {
    return "equal";
  }
  if (isAscii(leftValue) && isAscii(rightValue)) {
    return identifierCodeEquals(
      leftValue,
      rightValue,
      !leftQuoted,
      !rightQuoted,
    )
      ? "equal"
      : "distinct";
  }
  return "unknown";
}

function asciiInsensitiveComparison(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
  fullyDecidable: boolean,
): SqlCteIdentifierComparison {
  if (
    left === null ||
    typeof left !== "object" ||
    right === null ||
    typeof right !== "object"
  ) {
    return "unknown";
  }
  const leftQuoted = left.quoted;
  const leftValue = left.value;
  const rightQuoted = right.quoted;
  const rightValue = right.value;
  if (
    !validComparisonValue(leftValue, leftQuoted) ||
    !validComparisonValue(rightValue, rightQuoted)
  ) {
    return "unknown";
  }
  if (leftValue === rightValue) {
    return "equal";
  }
  if (
    fullyDecidable ||
    (isAscii(leftValue) && isAscii(rightValue))
  ) {
    return identifierCodeEquals(
      leftValue,
      rightValue,
      true,
      true,
    )
      ? "equal"
      : "distinct";
  }
  return "unknown";
}

function postgresPrefixMatch(
  candidate: SqlIdentifierComponent,
  prefix: SqlIdentifierComponent,
): SqlCteIdentifierPrefixMatch {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    prefix === null ||
    typeof prefix !== "object"
  ) {
    return "unknown";
  }
  const candidateQuoted = candidate.quoted;
  const candidateValue = candidate.value;
  const prefixQuoted = prefix.quoted;
  const prefixValue = prefix.value;
  if (
    !validComparisonValue(candidateValue, candidateQuoted) ||
    !validComparisonValue(prefixValue, prefixQuoted, true)
  ) {
    return "unknown";
  }
  if (prefixValue.length === 0) {
    return "match";
  }
  if (
    candidateQuoted === prefixQuoted &&
    candidateValue.startsWith(prefixValue)
  ) {
    return "match";
  }
  if (isAscii(candidateValue) && isAscii(prefixValue)) {
    return identifierPrefixMatches(
      candidateValue,
      prefixValue,
      !candidateQuoted,
      !prefixQuoted,
    )
      ? "match"
      : "no-match";
  }
  return candidateQuoted === prefixQuoted &&
    candidateValue.length < prefixValue.length
    ? "no-match"
    : "unknown";
}

function asciiInsensitivePrefixMatch(
  candidate: SqlIdentifierComponent,
  prefix: SqlIdentifierComponent,
  fullyDecidable: boolean,
): SqlCteIdentifierPrefixMatch {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    prefix === null ||
    typeof prefix !== "object"
  ) {
    return "unknown";
  }
  const candidateQuoted = candidate.quoted;
  const candidateValue = candidate.value;
  const prefixQuoted = prefix.quoted;
  const prefixValue = prefix.value;
  if (
    !validComparisonValue(candidateValue, candidateQuoted) ||
    !validComparisonValue(prefixValue, prefixQuoted, true)
  ) {
    return "unknown";
  }
  if (prefixValue.length === 0) {
    return "match";
  }
  if (candidateValue.startsWith(prefixValue)) {
    return "match";
  }
  if (
    fullyDecidable ||
    (isAscii(candidateValue) && isAscii(prefixValue))
  ) {
    return identifierPrefixMatches(
      candidateValue,
      prefixValue,
      true,
      true,
    )
      ? "match"
      : "no-match";
  }
  return "unknown";
}

function validComparisonValue(
  value: unknown,
  quoted: unknown,
  allowEmpty = false,
): value is string {
  return (
    typeof quoted === "boolean" &&
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !value.includes("\0") &&
    isWellFormed(value)
  );
}

function quoteDouble(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteBigQuery(value: string): string {
  let output = "`";
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const code = value.charCodeAt(cursor);
    if (code === 96) {
      output += "\\`";
    } else if (code === 92) {
      output += "\\\\";
    } else if (code === 7) {
      output += "\\a";
    } else if (code === 8) {
      output += "\\b";
    } else if (code === 9) {
      output += "\\t";
    } else if (code === 10) {
      output += "\\n";
    } else if (code === 11) {
      output += "\\v";
    } else if (code === 12) {
      output += "\\f";
    } else if (code === 13) {
      output += "\\r";
    } else if (code < 32 || code === 127) {
      output += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      output += value[cursor];
    }
  }
  return `${output}\``;
}

function legalRoleSequence(
  kind: SqlRelationDialectId,
  roles: readonly string[],
): boolean {
  if (roles.length === 0 || roles.at(-1) !== "relation") {
    return false;
  }
  const containers = roles.slice(0, -1);
  if (kind === "postgresql") {
    return (
      containers.length === 0 ||
      (containers.length === 1 && containers[0] === "schema")
    );
  }
  if (kind === "duckdb") {
    return (
      containers.length === 0 ||
      (containers.length === 1 &&
        (containers[0] === "catalog" ||
          containers[0] === "schema")) ||
      (containers.length === 2 &&
        containers[0] === "catalog" &&
        containers[1] === "schema")
    );
  }
  if (kind === "bigquery") {
    return (
      containers.length === 0 ||
      (containers.length === 1 && containers[0] === "dataset") ||
      (containers.length === 2 &&
        containers[0] === "project" &&
        containers[1] === "dataset")
    );
  }
  let cursor = 0;
  if (containers[0] === "catalog") {
    cursor = 1;
  }
  for (; cursor < containers.length; cursor += 1) {
    if (containers[cursor] !== "schema") {
      return false;
    }
  }
  return containers.length < MAX_QUERY_SITE_PATH_COMPONENTS;
}

function canRenderBare(
  spec: RelationDialectSpec,
  value: string,
  role: string,
  pathLength: number,
): boolean {
  if (isSqlRelationReservedWord(spec.kind, value)) {
    return false;
  }
  if (spec.kind !== "bigquery") {
    return spec.kind === "dremio"
      ? isDremioBareIdentifier(value)
      : isBareIdentifier(value, spec.kind === "postgresql");
  }
  if (
    (role === "project" ||
      (role === "relation" && pathLength === 1)) &&
    isBigQueryDashedIdentifier(value)
  ) {
    return true;
  }
  return isAscii(value) && isBareIdentifier(value, false);
}

function createRenderer(
  spec: RelationDialectSpec,
): SqlRelationCompletionDialectRuntime["renderRelationPath"] {
  return (path): SqlRenderedRelationPath => {
    try {
      if (!Array.isArray(path)) {
        return unsupportedPath();
      }
      const pathLength = path.length;
      if (pathLength === 0 || pathLength > spec.maximumPathDepth) {
        return unsupportedPath();
      }
      const roles: string[] = [];
      const components: {
        readonly quoted: boolean;
        readonly role: string;
        readonly value: string;
      }[] = [];
      for (let index = 0; index < pathLength; index += 1) {
        const component = path[index];
        if (
          component === null ||
          typeof component !== "object"
        ) {
          return unsupportedPath();
        }
        const role = component.role;
        const quoted = component.quoted;
        const value = component.value;
        if (
          typeof role !== "string" ||
          typeof quoted !== "boolean" ||
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > MAX_IDENTIFIER_LENGTH ||
          value.includes("\0") ||
          !isWellFormed(value)
        ) {
          return unsupportedPath();
        }
        roles.push(role);
        components.push({ quoted, role, value });
      }
      if (!legalRoleSequence(spec.kind, roles)) {
        return unsupportedPath();
      }
      const rendered = components.map((component) => {
        if (
          !component.quoted &&
          canRenderBare(
            spec,
            component.value,
            component.role,
            pathLength,
          )
        ) {
          return component.value;
        }
        return spec.kind === "bigquery"
          ? quoteBigQuery(component.value)
          : quoteDouble(component.value);
      });
      return Object.freeze({
        status: "rendered" as const,
        text: rendered.join("."),
      });
    } catch {
      return unsupportedPath();
    }
  };
}

function unsupportedPath(): SqlRenderedRelationPath {
  return Object.freeze({
    reason: "illegal-role-sequence" as const,
    status: "unsupported" as const,
  });
}

function createRuntime(spec: RelationDialectSpec): SqlRelationDialectRuntime {
  let decodeIdentifierImplementation: SqlRelationCompletionDialectRuntime["decodeIdentifier"];
  switch (spec.kind) {
    case "bigquery":
      decodeIdentifierImplementation = decodeBigQueryIdentifier;
      break;
    case "dremio":
      decodeIdentifierImplementation = (token, mode) =>
        decodeDoubleQuoted(token, mode, "dremio");
      break;
    case "duckdb":
      decodeIdentifierImplementation = (token, mode) =>
        decodeDoubleQuoted(token, mode, "duckdb");
      break;
    case "postgresql":
      decodeIdentifierImplementation = (token, mode) =>
        decodeDoubleQuoted(token, mode, "postgresql");
      break;
  }
  const decodeIdentifier:
    SqlRelationCompletionDialectRuntime["decodeIdentifier"] = (
      token,
      mode,
    ) => {
      try {
        return typeof token === "string" &&
          (mode === "complete" || mode === "completion-prefix")
          ? decodeIdentifierImplementation(token, mode)
          : INVALID_IDENTIFIER;
      } catch {
        return INVALID_IDENTIFIER;
      }
    };
  const compareCteIdentifiersImplementation =
    spec.kind === "postgresql"
      ? postgresComparison
      : (left: SqlIdentifierComponent, right: SqlIdentifierComponent) =>
          asciiInsensitiveComparison(
            left,
            right,
            spec.kind === "duckdb",
          );
  const compareCteIdentifiers:
    SqlRelationCompletionDialectRuntime["compareCteIdentifiers"] = (
      left,
      right,
    ) => {
      try {
        return compareCteIdentifiersImplementation(left, right);
      } catch {
        return "unknown";
      }
    };
  const cteIdentifierMatchesPrefixImplementation =
    spec.kind === "postgresql"
      ? postgresPrefixMatch
      : (
          candidate: SqlIdentifierComponent,
          prefix: SqlIdentifierComponent,
        ) =>
          asciiInsensitivePrefixMatch(
            candidate,
            prefix,
            spec.kind === "duckdb",
          );
  const cteIdentifierMatchesPrefix:
    SqlRelationCompletionDialectRuntime["cteIdentifierMatchesPrefix"] = (
      candidate,
      prefix,
    ) => {
      try {
        return cteIdentifierMatchesPrefixImplementation(
          candidate,
          prefix,
        );
      } catch {
        return "unknown";
      }
    };
  const completion: SqlRelationCompletionDialectRuntime = Object.freeze({
    compareCteIdentifiers,
    cteIdentifierMatchesPrefix,
    decodeIdentifier,
    renderRelationPath: createRenderer(spec),
  });
  const cteLayout: SqlCteLayoutDialect = Object.freeze({
    classifyIdentifierToken: createCteClassifier(decodeIdentifier),
    compareCteIdentifiers,
    grammar: spec.cteGrammar,
    lexicalProfile: spec.lexicalProfile,
  });
  const querySite: SqlQuerySiteDialect = Object.freeze({
    classifyIdentifierToken: createQueryClassifier(
      spec.kind,
      decodeIdentifier,
    ),
    decodeRelationPath: createPathDecoder(spec, decodeIdentifier),
    lexicalProfile: spec.lexicalProfile,
    maximumPathDepth: spec.maximumPathDepth,
    ...(spec.kind === "bigquery" ? { optionalDmlInto: true } : {}),
    supportsNaturalJoin: spec.supportsNaturalJoin,
  });
  return registerSqlRelationDialectRuntime(
    Object.freeze({
      completion,
      cteLayout,
      id: spec.kind,
      querySite,
    }),
  );
}

function createGrammar(
  declaredColumns: boolean,
  materialization: boolean,
  maximumDeclarationsPerFrame: number,
  recursive: boolean,
): SqlCteLayoutDialect["grammar"] {
  return Object.freeze({
    declaredColumns,
    materialization,
    maximumDeclarationsPerFrame,
    recursive,
  });
}

export const POSTGRESQL_SQL_RELATION_DIALECT =
  createRuntime({
    cteGrammar: createGrammar(
      true,
      true,
      MAX_CTE_DECLARATIONS,
      true,
    ),
    kind: "postgresql",
    lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
    maximumPathDepth: 2,
    supportsNaturalJoin: true,
  });

export const DUCKDB_SQL_RELATION_DIALECT =
  createRuntime({
    cteGrammar: createGrammar(
      true,
      true,
      MAX_CTE_DECLARATIONS,
      true,
    ),
    kind: "duckdb",
    lexicalProfile: DUCKDB_SQL_LEXICAL_PROFILE,
    maximumPathDepth: 3,
    supportsNaturalJoin: true,
  });

export const BIGQUERY_SQL_RELATION_DIALECT =
  createRuntime({
    cteGrammar: createGrammar(
      false,
      false,
      MAX_CTE_DECLARATIONS,
      true,
    ),
    kind: "bigquery",
    lexicalProfile: BIGQUERY_SQL_LEXICAL_PROFILE,
    maximumPathDepth: 3,
    supportsNaturalJoin: false,
  });

export const DREMIO_SQL_RELATION_DIALECT =
  createRuntime({
    cteGrammar: createGrammar(true, false, 1, false),
    kind: "dremio",
    lexicalProfile: DREMIO_SQL_LEXICAL_PROFILE,
    maximumPathDepth: MAX_QUERY_SITE_PATH_COMPONENTS,
    supportsNaturalJoin: false,
  });
