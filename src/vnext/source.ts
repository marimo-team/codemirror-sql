import type { SqlTextRange } from "./types.js";

export const MAX_SQL_SOURCE_LENGTH = 16 * 1024 * 1024;
export const MAX_SQL_EMBEDDED_REGIONS = 10_000;

const MAX_EMBEDDED_LANGUAGE_LENGTH = 256;
const MASK_CHUNK_LENGTH = 64 * 1024;
const EMPTY_EMBEDDED_REGIONS: readonly SqlEmbeddedRegion[] = Object.freeze([]);
const sourceErrors = new WeakSet<object>();

export type SqlSourceErrorCode =
  | "invalid-source"
  | "invalid-range"
  | "invalid-region";

export class SqlSourceError extends Error {
  readonly code: SqlSourceErrorCode;

  constructor(code: SqlSourceErrorCode, message: string) {
    super(message);
    this.name = "SqlSourceError";
    this.code = code;
    sourceErrors.add(this);
  }
}

export function isSqlSourceError(error: unknown): error is SqlSourceError {
  return (
    error !== null &&
    typeof error === "object" &&
    sourceErrors.has(error)
  );
}

export interface SqlEmbeddedRegion extends SqlTextRange {
  readonly language: string;
}

export interface SqlSourceSnapshot {
  readonly analysisText: string;
  readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  readonly originalText: string;
}

interface MissingDataProperty {
  readonly found: false;
}

interface FoundDataProperty {
  readonly found: true;
  readonly value: unknown;
}

type DataProperty = MissingDataProperty | FoundDataProperty;

function readOwnDataProperty(
  value: object,
  key: PropertyKey,
  subject: string,
): DataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return { found: false };
  }
  if (!("value" in descriptor)) {
    throw new SqlSourceError(
      "invalid-source",
      `${subject} property ${String(key)} cannot be an accessor`,
    );
  }
  return { found: true, value: descriptor.value };
}

function readRequiredDataProperty(
  value: object,
  key: PropertyKey,
  subject: string,
  missingCode: SqlSourceErrorCode = "invalid-source",
): unknown {
  const property = readOwnDataProperty(value, key, subject);
  if (!property.found) {
    throw new SqlSourceError(
      missingCode,
      `${subject} requires a data property named ${String(key)}`,
    );
  }
  return property.value;
}

function normalizeSourceError(error: unknown, message: string): never {
  if (isSqlSourceError(error)) {
    throw error;
  }
  throw new SqlSourceError("invalid-source", message);
}

function normalizeSourceText(text: unknown): string {
  if (typeof text !== "string") {
    throw new SqlSourceError("invalid-source", "SQL source text must be a string");
  }
  if (text.length > MAX_SQL_SOURCE_LENGTH) {
    throw new SqlSourceError(
      "invalid-source",
      `SQL source cannot exceed ${MAX_SQL_SOURCE_LENGTH} UTF-16 code units`,
    );
  }
  return text;
}

export function normalizeSqlTextRange(
  range: unknown,
  sourceLength: number,
  subject = "SQL text range",
): SqlTextRange {
  try {
    if (
      !Number.isSafeInteger(sourceLength) ||
      sourceLength < 0 ||
      sourceLength > MAX_SQL_SOURCE_LENGTH
    ) {
      throw new SqlSourceError(
        "invalid-range",
        "SQL range source length is invalid",
      );
    }
    if (range === null || typeof range !== "object") {
      throw new SqlSourceError(
        "invalid-range",
        `${subject} must be an object`,
      );
    }
    const from = readRequiredDataProperty(
      range,
      "from",
      subject,
      "invalid-range",
    );
    const to = readRequiredDataProperty(range, "to", subject, "invalid-range");
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      from > to ||
      to > sourceLength
    ) {
      throw new SqlSourceError(
        "invalid-range",
        `${subject} must be an in-bounds half-open UTF-16 range`,
      );
    }
    return Object.freeze({ from, to });
  } catch (error) {
    return normalizeSourceError(error, `${subject} could not be inspected safely`);
  }
}

function readArrayLength(value: readonly unknown[]): number {
  const length = readRequiredDataProperty(
    value,
    "length",
    "SQL embedded regions",
  );
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new SqlSourceError(
      "invalid-region",
      "SQL embedded regions have an invalid length",
    );
  }
  return length;
}

function validateRegionArrayKeys(
  regions: readonly unknown[],
  length: number,
): void {
  for (const key of Reflect.ownKeys(regions)) {
    if (key === "length") {
      continue;
    }
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= length
    ) {
      throw new SqlSourceError(
        "invalid-region",
        "SQL embedded regions cannot contain custom properties",
      );
    }
  }
}

function normalizeEmbeddedRegions(
  regions: unknown,
  sourceLength: number,
): readonly SqlEmbeddedRegion[] {
  try {
    if (!Array.isArray(regions)) {
      throw new SqlSourceError(
        "invalid-region",
        "SQL embedded regions must be an array",
      );
    }
    const length = readArrayLength(regions);
    if (length > MAX_SQL_EMBEDDED_REGIONS) {
      throw new SqlSourceError(
        "invalid-region",
        `SQL source cannot contain more than ${MAX_SQL_EMBEDDED_REGIONS} embedded regions`,
      );
    }
    validateRegionArrayKeys(regions, length);

    const normalized: SqlEmbeddedRegion[] = [];
    let previousEnd = 0;
    for (let index = 0; index < length; index += 1) {
      const candidate = readRequiredDataProperty(
        regions,
        index,
        `SQL embedded region ${index}`,
      );
      if (candidate === null || typeof candidate !== "object") {
        throw new SqlSourceError(
          "invalid-region",
          `SQL embedded region ${index} must be an object`,
        );
      }
      let range: SqlTextRange;
      try {
        range = normalizeSqlTextRange(
          candidate,
          sourceLength,
          `SQL embedded region ${index}`,
        );
      } catch (error) {
        if (
          !isSqlSourceError(error) ||
          error.code !== "invalid-range"
        ) {
          throw error;
        }
        throw new SqlSourceError(
          "invalid-region",
          `SQL embedded region ${index} has an invalid range`,
        );
      }
      if (range.from === range.to) {
        throw new SqlSourceError(
          "invalid-region",
          `SQL embedded region ${index} cannot be empty`,
        );
      }
      if (range.from < previousEnd) {
        throw new SqlSourceError(
          "invalid-region",
          "SQL embedded regions must be ordered and non-overlapping",
        );
      }
      const language = readRequiredDataProperty(
        candidate,
        "language",
        `SQL embedded region ${index}`,
      );
      if (
        typeof language !== "string" ||
        language.length === 0 ||
        language.length > MAX_EMBEDDED_LANGUAGE_LENGTH
      ) {
        throw new SqlSourceError(
          "invalid-region",
          `SQL embedded region ${index} has an invalid language`,
        );
      }
      normalized.push(
        Object.freeze({
          from: range.from,
          language,
          to: range.to,
        }),
      );
      previousEnd = range.to;
    }
    return Object.freeze(normalized);
  } catch (error) {
    return normalizeSourceError(
      error,
      "SQL embedded regions could not be inspected safely",
    );
  }
}

function maskRegion(text: string, from: number, to: number): string {
  let output = "";
  for (let cursor = from; cursor < to; cursor += MASK_CHUNK_LENGTH) {
    const chunk = text.slice(cursor, Math.min(to, cursor + MASK_CHUNK_LENGTH));
    output += chunk.replace(/[^\r\n]+/g, (value) => " ".repeat(value.length));
  }
  return output;
}

export function createIdentitySqlSource(text: unknown): SqlSourceSnapshot {
  const originalText = normalizeSourceText(text);
  return Object.freeze({
    analysisText: originalText,
    embeddedRegions: EMPTY_EMBEDDED_REGIONS,
    originalText,
  });
}

export function createMaskedSqlSource(
  text: unknown,
  regions: unknown,
): SqlSourceSnapshot {
  const originalText = normalizeSourceText(text);
  const embeddedRegions = normalizeEmbeddedRegions(
    regions,
    originalText.length,
  );
  if (embeddedRegions.length === 0) {
    return createIdentitySqlSource(originalText);
  }

  const output: string[] = [];
  let cursor = 0;
  for (const region of embeddedRegions) {
    output.push(
      originalText.slice(cursor, region.from),
      maskRegion(originalText, region.from, region.to),
    );
    cursor = region.to;
  }
  output.push(originalText.slice(cursor));
  const analysisText = output.join("");
  return Object.freeze({
    analysisText,
    embeddedRegions,
    originalText,
  });
}

export function mapAnalysisRangeToOriginal(
  source: SqlSourceSnapshot,
  range: unknown,
): SqlTextRange {
  return normalizeSqlTextRange(
    range,
    source.analysisText.length,
    "SQL analysis range",
  );
}

export function mapOriginalRangeToAnalysis(
  source: SqlSourceSnapshot,
  range: unknown,
): SqlTextRange {
  return normalizeSqlTextRange(
    range,
    source.originalText.length,
    "SQL original range",
  );
}
