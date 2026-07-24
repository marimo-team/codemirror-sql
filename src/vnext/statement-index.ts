import type { SqlTextChange } from "./types.js";
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

export {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
} from "./lexical.js";
export type { SqlLexicalProfile } from "./lexical.js";

const analysisRangeBrand: unique symbol = Symbol("SqlAnalysisRange");

export const MAX_SQL_STATEMENT_SLOTS = 10_000;
const MAX_PREFIX_TOKENS = 6;

export interface SqlAnalysisRange {
  readonly [analysisRangeBrand]: "SqlAnalysisRange";
  readonly from: number;
  readonly to: number;
}

export type SqlCursorAffinity = "left" | "right";

export type SqlUnterminatedConstruct =
  | "backtick-quoted-identifier"
  | "block-comment"
  | "dollar-quoted-string"
  | "double-quoted-identifier"
  | "double-quoted-string"
  | "single-quoted-string"
  | "triple-double-quoted-string"
  | "triple-single-quoted-string";

export type SqlOpaqueBoundaryReason =
  | "custom-delimiter"
  | "procedural-block"
  | "resource-limit";

export type SqlLexicalEndState =
  | {
      readonly kind: "normal";
    }
  | {
      readonly construct: SqlUnterminatedConstruct;
      readonly from: number;
      readonly kind: "unterminated";
    }
  | {
      readonly from: number;
      readonly kind: "opaque";
      readonly reason: SqlOpaqueBoundaryReason;
    };

export interface ExactSqlStatementSlot {
  readonly boundaryQuality: "exact";
  readonly endState: Exclude<SqlLexicalEndState, { readonly kind: "opaque" }>;
  readonly extent: SqlAnalysisRange;
  readonly hasCode: boolean;
  readonly source: SqlAnalysisRange;
  readonly terminator: SqlAnalysisRange | null;
}

export interface OpaqueSqlStatementSlot {
  readonly boundaryQuality: "opaque";
  readonly endState: Extract<SqlLexicalEndState, { readonly kind: "opaque" }>;
  readonly extent: SqlAnalysisRange;
}

export type SqlStatementSlot =
  | ExactSqlStatementSlot
  | OpaqueSqlStatementSlot;

export interface SqlStatementIndex {
  readonly endState: SqlLexicalEndState;
  readonly quality: "exact" | "opaque";
  readonly slots: readonly SqlStatementSlot[];
}

const NORMAL_END_STATE: Extract<
  SqlLexicalEndState,
  { readonly kind: "normal" }
> = Object.freeze({ kind: "normal" });

function createAnalysisRange(from: number, to: number): SqlAnalysisRange {
  const range: SqlAnalysisRange = {
    [analysisRangeBrand]: "SqlAnalysisRange",
    from,
    to,
  };
  return Object.freeze(range);
}

function createUnterminatedEndState(
  construct: SqlUnterminatedConstruct,
  from: number,
): Extract<SqlLexicalEndState, { readonly kind: "unterminated" }> {
  return Object.freeze({ construct, from, kind: "unterminated" });
}

function createOpaqueEndState(
  reason: SqlOpaqueBoundaryReason,
  from: number,
): Extract<SqlLexicalEndState, { readonly kind: "opaque" }> {
  return Object.freeze({ from, kind: "opaque", reason });
}

function createExactSlot(
  from: number,
  sourceTo: number,
  extentTo: number,
  hasCode: boolean,
  endState: ExactSqlStatementSlot["endState"],
): ExactSqlStatementSlot {
  return Object.freeze({
    boundaryQuality: "exact",
    endState,
    extent: createAnalysisRange(from, extentTo),
    hasCode,
    source: createAnalysisRange(from, sourceTo),
    terminator:
      sourceTo === extentTo ? null : createAnalysisRange(sourceTo, extentTo),
  });
}

function createOpaqueSlot(
  from: number,
  to: number,
  reason: SqlOpaqueBoundaryReason,
  detectedAt: number,
): OpaqueSqlStatementSlot {
  return Object.freeze({
    boundaryQuality: "opaque",
    endState: createOpaqueEndState(reason, detectedAt),
    extent: createAnalysisRange(from, to),
  });
}

class SqlPrefixGuard {
  readonly #mode: SqlLexicalProfile["proceduralGuards"];
  readonly #tokens: string[] = [];
  #labelColonAt: number | null = null;
  #parenthesisDepth = 0;
  #postgresRoutine = false;
  #previousRoutineWord: string | null = null;
  #previousRoutineWordAt = 0;
  #reason: SqlOpaqueBoundaryReason | null = null;
  #reasonAt = 0;

  constructor(mode: SqlLexicalProfile["proceduralGuards"]) {
    this.#mode = mode;
  }

  reset(): void {
    this.#tokens.length = 0;
    this.#labelColonAt = null;
    this.#parenthesisDepth = 0;
    this.#postgresRoutine = false;
    this.#previousRoutineWord = null;
    this.#previousRoutineWordAt = 0;
    this.#reason = null;
    this.#reasonAt = 0;
  }

  recordWord(text: string, from: number, to: number): void {
    if (this.#reason !== null) {
      return;
    }
    if (this.#postgresRoutine) {
      const token =
        to - from <= 32 ? text.slice(from, to).toUpperCase() : "<IDENTIFIER>";
      if (this.#previousRoutineWord === "BEGIN" && token === "ATOMIC") {
        if (this.#parenthesisDepth === 0) {
          this.#setReason("procedural-block", this.#previousRoutineWordAt);
          return;
        }
      }
      this.#previousRoutineWord = token;
      this.#previousRoutineWordAt = from;
      return;
    }
    if (this.#tokens.length >= MAX_PREFIX_TOKENS) {
      return;
    }
    const token =
      to - from <= 32 ? text.slice(from, to).toUpperCase() : "<IDENTIFIER>";
    this.#tokens.push(token);

    if (this.#tokens.length === 1 && token === "DELIMITER") {
      this.#setReason("custom-delimiter", from);
      return;
    }
    if (
      this.#mode === "postgresql" &&
      isCreatePostgresqlRoutinePrefix(this.#tokens)
    ) {
      this.#postgresRoutine = true;
      this.#previousRoutineWord = token;
      this.#previousRoutineWordAt = from;
      return;
    }
    if (this.#mode !== "bigquery") {
      return;
    }
    if (
      this.#tokens.length === 1 &&
      (token === "FOR" ||
        token === "IF" ||
        token === "LOOP" ||
        token === "REPEAT" ||
        token === "WHILE")
    ) {
      this.#setReason("procedural-block", from);
      return;
    }
    if (
      this.#tokens.length === 2 &&
      this.#tokens[0] === "BEGIN" &&
      token !== "TRANSACTION"
    ) {
      this.#setReason("procedural-block", from);
      return;
    }
    if (
      this.#labelColonAt !== null &&
      this.#tokens.length === 2 &&
      (token === "BEGIN" ||
        token === "FOR" ||
        token === "LOOP" ||
        token === "REPEAT" ||
        token === "WHILE")
    ) {
      this.#setReason("procedural-block", this.#labelColonAt);
      return;
    }
    if (isCreateProcedurePrefix(this.#tokens)) {
      this.#setReason("procedural-block", from);
    }
  }

  recordQuotedIdentifier(): void {
    if (
      this.#reason === null &&
      this.#mode === "bigquery" &&
      this.#tokens.length < MAX_PREFIX_TOKENS
    ) {
      this.#tokens.push("<IDENTIFIER>");
    }
  }

  recordNonWord(code: number): void {
    if (this.#mode !== "postgresql" || !this.#postgresRoutine) {
      return;
    }
    if (code === 40) {
      this.#parenthesisDepth += 1;
    } else if (code === 41 && this.#parenthesisDepth > 0) {
      this.#parenthesisDepth -= 1;
    }
    this.#previousRoutineWord = null;
  }

  recordColon(at: number): void {
    if (
      this.#mode === "bigquery" &&
      this.#reason === null &&
      this.#tokens.length === 1
    ) {
      this.#labelColonAt = at;
    }
  }

  get reason(): SqlOpaqueBoundaryReason | null {
    return this.#reason;
  }

  get reasonAt(): number {
    return this.#reasonAt;
  }

  #setReason(reason: SqlOpaqueBoundaryReason, at: number): void {
    this.#reason = reason;
    this.#reasonAt = at;
  }
}

function isCreatePostgresqlRoutinePrefix(tokens: readonly string[]): boolean {
  if (tokens[0] !== "CREATE") {
    return false;
  }
  if (tokens[1] === "FUNCTION" || tokens[1] === "PROCEDURE") {
    return true;
  }
  return (
    tokens[1] === "OR" &&
    tokens[2] === "REPLACE" &&
    (tokens[3] === "FUNCTION" || tokens[3] === "PROCEDURE")
  );
}

function isCreateProcedurePrefix(tokens: readonly string[]): boolean {
  if (tokens[0] !== "CREATE") {
    return false;
  }
  if (tokens[1] === "PROCEDURE") {
    return true;
  }
  if (
    (tokens[1] === "TEMP" || tokens[1] === "TEMPORARY") &&
    tokens[2] === "PROCEDURE"
  ) {
    return true;
  }
  if (tokens[1] !== "OR" || tokens[2] !== "REPLACE") {
    return false;
  }
  return (
    tokens[3] === "PROCEDURE" ||
    ((tokens[3] === "TEMP" || tokens[3] === "TEMPORARY") &&
      tokens[4] === "PROCEDURE")
  );
}

function quoteConstruct(
  quote: number,
  quoteLength: 1 | 3,
  bigQueryStrings: boolean,
): SqlUnterminatedConstruct {
  if (quoteLength === 3) {
    return quote === 39
      ? "triple-single-quoted-string"
      : "triple-double-quoted-string";
  }
  if (quote === 39) {
    return "single-quoted-string";
  }
  return bigQueryStrings
    ? "double-quoted-string"
    : "double-quoted-identifier";
}

interface SqlStatementScanOptions {
  readonly from: number;
  readonly prefixSlots: readonly SqlStatementSlot[];
  readonly tryReuseSuffix?: (
    boundary: number,
    scannedSlots: readonly SqlStatementSlot[],
  ) => SqlStatementIndex | null;
}

function createStatementIndex(
  slots: SqlStatementSlot[],
): SqlStatementIndex {
  const finalSlot = getStatementSlot(slots, slots.length - 1);
  return Object.freeze({
    endState: finalSlot.endState,
    quality:
      finalSlot.boundaryQuality === "opaque" ? "opaque" : "exact",
    slots: Object.freeze(slots),
  });
}

function scanSqlStatementIndex(
  analysisText: string,
  profile: SqlLexicalProfile,
  options: SqlStatementScanOptions,
): SqlStatementIndex {
  const slots: SqlStatementSlot[] = [...options.prefixSlots];
  const prefixGuard = new SqlPrefixGuard(profile.proceduralGuards);
  let slotFrom = options.from;
  let hasCode = false;
  let cursor = options.from;
  let finalEndState: ExactSqlStatementSlot["endState"] = NORMAL_END_STATE;

  const finishOpaque = (
    reason: SqlOpaqueBoundaryReason,
    detectedAt: number,
  ): SqlStatementIndex => {
    const slot = createOpaqueSlot(
      slotFrom,
      analysisText.length,
      reason,
      detectedAt,
    );
    slots.push(slot);
    return createStatementIndex(slots);
  };

  while (cursor < analysisText.length) {
    const code = analysisText.charCodeAt(cursor);
    const next = analysisText.charCodeAt(cursor + 1);

    if (isSqlWhitespace(code)) {
      cursor += 1;
      continue;
    }
    if (code === 45 && next === 45) {
      cursor += 2;
      while (
        cursor < analysisText.length &&
        analysisText.charCodeAt(cursor) !== 10 &&
        analysisText.charCodeAt(cursor) !== 13
      ) {
        cursor += 1;
      }
      continue;
    }
    if (profile.hashLineComments && code === 35) {
      cursor += 1;
      while (
        cursor < analysisText.length &&
        analysisText.charCodeAt(cursor) !== 10 &&
        analysisText.charCodeAt(cursor) !== 13
      ) {
        cursor += 1;
      }
      continue;
    }
    if (code === 47 && next === 42) {
      const comment = scanSqlBlockComment(
        analysisText,
        cursor,
        analysisText.length,
        profile.nestedBlockComments,
      );
      if (!comment.closed) {
        finalEndState = createUnterminatedEndState("block-comment", cursor);
      }
      cursor = comment.to;
      continue;
    }

    if (
      profile.dollarQuotedStrings &&
      code === 36
    ) {
      const dollarQuote = scanSqlDollarQuote(
        analysisText,
        cursor,
        analysisText.length,
      );
      if (dollarQuote) {
        hasCode = true;
        prefixGuard.recordNonWord(code);
        if (dollarQuote.delimiterTooLong) {
          return finishOpaque("resource-limit", cursor);
        }
        if (!dollarQuote.closed) {
          finalEndState = createUnterminatedEndState(
            "dollar-quoted-string",
            cursor,
          );
        }
        cursor = dollarQuote.to;
        continue;
      }
    }

    if (
      code === 39 ||
      code === 34 ||
      (profile.backtickQuotedIdentifiers && code === 96)
    ) {
      hasCode = true;
      if (code === 96) {
        prefixGuard.recordQuotedIdentifier();
        prefixGuard.recordNonWord(code);
        const quote = scanSqlQuoted(
          analysisText,
          cursor,
          analysisText.length,
          code,
          1,
          true,
          false,
          false,
        );
        if (!quote.closed) {
          finalEndState = createUnterminatedEndState(
            "backtick-quoted-identifier",
            cursor,
          );
        }
        cursor = quote.to;
        continue;
      }

      const isTriple =
        profile.bigQueryStrings &&
        analysisText.charCodeAt(cursor + 1) === code &&
        analysisText.charCodeAt(cursor + 2) === code;
      const quoteLength = isTriple ? 3 : 1;
      const rawBigQueryString =
        profile.bigQueryStrings && isBigQueryRawString(analysisText, cursor);
      const backslashEscapes =
        !rawBigQueryString &&
        (profile.bigQueryStrings ||
          (code === 39 &&
            (profile.singleQuoteBackslash === "always" ||
              (profile.singleQuoteBackslash === "e-prefix" &&
                hasEscapeStringPrefix(analysisText, cursor)))));
      const doubledQuoteEscapes = !profile.bigQueryStrings;
      if (code === 34 && !profile.bigQueryStrings) {
        prefixGuard.recordQuotedIdentifier();
      }
      prefixGuard.recordNonWord(code);
      const quote = scanSqlQuoted(
        analysisText,
        cursor,
        analysisText.length,
        code,
        quoteLength,
        backslashEscapes,
        doubledQuoteEscapes,
        profile.bigQueryStrings && quoteLength === 1,
      );
      if (!quote.closed) {
        finalEndState = createUnterminatedEndState(
          quoteConstruct(code, quoteLength, profile.bigQueryStrings),
          cursor,
        );
      }
      cursor = quote.to;
      continue;
    }

    const wordStartLength = sqlIdentifierStartLengthAt(analysisText, cursor);
    if (wordStartLength > 0) {
      const wordFrom = cursor;
      cursor += wordStartLength;
      while (cursor < analysisText.length) {
        const continueLength = sqlIdentifierContinueLengthAt(
          analysisText,
          cursor,
        );
        if (continueLength === 0) {
          break;
        }
        cursor += continueLength;
      }
      prefixGuard.recordWord(analysisText, wordFrom, cursor);
      hasCode = true;
      if (prefixGuard.reason !== null) {
        return finishOpaque(prefixGuard.reason, prefixGuard.reasonAt);
      }
      continue;
    }

    if (code === 58) {
      prefixGuard.recordColon(cursor);
    }
    prefixGuard.recordNonWord(code);
    if (code === 59) {
      if (slots.length >= MAX_SQL_STATEMENT_SLOTS - 1) {
        return finishOpaque("resource-limit", cursor);
      }
      slots.push(
        createExactSlot(
          slotFrom,
          cursor,
          cursor + 1,
          hasCode,
          NORMAL_END_STATE,
        ),
      );
      slotFrom = cursor + 1;
      hasCode = false;
      finalEndState = NORMAL_END_STATE;
      prefixGuard.reset();
      cursor += 1;
      const reused = options.tryReuseSuffix?.(slotFrom, slots);
      if (reused) {
        return reused;
      }
      continue;
    }

    hasCode = true;
    cursor += 1;
  }

  slots.push(
    createExactSlot(
      slotFrom,
      analysisText.length,
      analysisText.length,
      hasCode,
      finalEndState,
    ),
  );
  return createStatementIndex(slots);
}

/** Builds the bounded, parser-free statement partition for one analysis text. */
export function buildSqlStatementIndex(
  analysisText: string,
  profile: SqlLexicalProfile,
): SqlStatementIndex {
  return scanSqlStatementIndex(analysisText, profile, {
    from: 0,
    prefixSlots: [],
  });
}

function statementSlotIndexAt(
  slots: readonly SqlStatementSlot[],
  position: number,
  affinity: SqlCursorAffinity,
): number {
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (getStatementSlot(slots, middle).extent.from <= position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let slotIndex = Math.max(0, low - 1);
  if (
    affinity === "left" &&
    position > 0 &&
    getStatementSlot(slots, slotIndex).extent.from === position
  ) {
    slotIndex -= 1;
  }
  return Math.max(0, slotIndex);
}

function statementSlotAtOrAfter(
  slots: readonly SqlStatementSlot[],
  position: number,
): number {
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const from = getStatementSlot(slots, middle).extent.from;
    if (from < position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function shiftEndState(
  endState: ExactSqlStatementSlot["endState"],
  delta: number,
): ExactSqlStatementSlot["endState"];
function shiftEndState(
  endState: OpaqueSqlStatementSlot["endState"],
  delta: number,
): OpaqueSqlStatementSlot["endState"];
function shiftEndState(
  endState: SqlLexicalEndState,
  delta: number,
): SqlLexicalEndState {
  if (endState.kind === "normal") {
    return endState;
  }
  return endState.kind === "opaque"
    ? createOpaqueEndState(endState.reason, endState.from + delta)
    : createUnterminatedEndState(
        endState.construct,
        endState.from + delta,
      );
}

function shiftStatementSlot(
  slot: SqlStatementSlot,
  delta: number,
): SqlStatementSlot {
  if (slot.boundaryQuality === "opaque") {
    return Object.freeze({
      boundaryQuality: "opaque",
      endState: shiftEndState(slot.endState, delta),
      extent: createAnalysisRange(
        slot.extent.from + delta,
        slot.extent.to + delta,
      ),
    });
  }
  return Object.freeze({
    boundaryQuality: "exact",
    endState: shiftEndState(slot.endState, delta),
    extent: createAnalysisRange(
      slot.extent.from + delta,
      slot.extent.to + delta,
    ),
    hasCode: slot.hasCode,
    source: createAnalysisRange(
      slot.source.from + delta,
      slot.source.to + delta,
    ),
    terminator: slot.terminator
      ? createAnalysisRange(
          slot.terminator.from + delta,
          slot.terminator.to + delta,
        )
      : null,
  });
}

function normalizeTrustedChanges(
  changes: readonly SqlTextChange[],
  previousLength: number,
  nextLength: number,
): {
  readonly delta: number;
  readonly first: SqlTextChange;
  readonly oldStableFrom: number;
} | null {
  const first = changes[0];
  if (!first) {
    return null;
  }
  let previousEnd = 0;
  let delta = 0;
  for (const change of changes) {
    if (
      !Number.isSafeInteger(change.from) ||
      !Number.isSafeInteger(change.to) ||
      change.from < previousEnd ||
      change.from < 0 ||
      change.from > change.to ||
      change.to > previousLength ||
      typeof change.insert !== "string"
    ) {
      return null;
    }
    delta += change.insert.length - (change.to - change.from);
    previousEnd = change.to;
  }
  const last = changes[changes.length - 1];
  if (!last || previousLength + delta !== nextLength) {
    return null;
  }
  return { delta, first, oldStableFrom: last.to };
}

/**
 * Updates an index from trusted, normalized analysis-coordinate changes.
 * Falls back to the full oracle whenever the change metadata is inconsistent.
 */
export function updateSqlStatementIndex(
  previousIndex: SqlStatementIndex,
  nextAnalysisText: string,
  changes: readonly SqlTextChange[],
  profile: SqlLexicalProfile,
): SqlStatementIndex {
  const previousSlots = previousIndex.slots;
  const previousLength = getStatementSlot(
    previousSlots,
    previousSlots.length - 1,
  ).extent.to;
  if (changes.length === 0) {
    return previousLength === nextAnalysisText.length
      ? previousIndex
      : buildSqlStatementIndex(nextAnalysisText, profile);
  }
  const normalized = normalizeTrustedChanges(
    changes,
    previousLength,
    nextAnalysisText.length,
  );
  if (!normalized) {
    return buildSqlStatementIndex(nextAnalysisText, profile);
  }

  const restartIndex = statementSlotIndexAt(
    previousSlots,
    normalized.first.from,
    "left",
  );
  const restartFrom = getStatementSlot(
    previousSlots,
    restartIndex,
  ).extent.from;
  const prefixSlots = previousSlots.slice(0, restartIndex);
  const newStableFrom = normalized.oldStableFrom + normalized.delta;
  let oldSuffixCursor = statementSlotAtOrAfter(
    previousSlots,
    normalized.oldStableFrom,
  );
  const previousFinalSlot = getStatementSlot(
    previousSlots,
    previousSlots.length - 1,
  );
  const previousHasResourceLimit =
    previousFinalSlot.boundaryQuality === "opaque" &&
    previousFinalSlot.endState.reason === "resource-limit";

  return scanSqlStatementIndex(nextAnalysisText, profile, {
    from: restartFrom,
    prefixSlots,
    tryReuseSuffix: (newBoundary, scannedSlots) => {
      if (newBoundary < newStableFrom) {
        return null;
      }
      const oldBoundary = newBoundary - normalized.delta;
      while (
        oldSuffixCursor < previousSlots.length &&
        getStatementSlot(
          previousSlots,
          oldSuffixCursor,
        ).extent.from < oldBoundary
      ) {
        oldSuffixCursor += 1;
      }
      if (
        oldSuffixCursor >= previousSlots.length ||
        getStatementSlot(
          previousSlots,
          oldSuffixCursor,
        ).extent.from !== oldBoundary
      ) {
        return null;
      }
      const oldSuffixLength = previousSlots.length - oldSuffixCursor;
      if (
        scannedSlots.length + oldSuffixLength >
        MAX_SQL_STATEMENT_SLOTS
      ) {
        return null;
      }
      if (
        previousHasResourceLimit &&
        scannedSlots.length !== oldSuffixCursor
      ) {
        return null;
      }
      const oldSuffix = previousSlots.slice(oldSuffixCursor);
      const suffix =
        normalized.delta === 0
          ? oldSuffix
          : oldSuffix.map((slot) =>
              shiftStatementSlot(slot, normalized.delta),
            );
      return createStatementIndex([...scannedSlots, ...suffix]);
    },
  });
}

/** Finds one slot with explicit behavior at shared extent boundaries. */
export function findSqlStatementSlot(
  index: SqlStatementIndex,
  position: number,
  affinity: SqlCursorAffinity,
): SqlStatementSlot {
  const slots = index.slots;
  const documentLength = getStatementSlot(slots, slots.length - 1).extent.to;
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > documentLength
  ) {
    throw new RangeError("SQL statement position is outside the document");
  }
  if (affinity !== "left" && affinity !== "right") {
    throw new TypeError("SQL cursor affinity must be left or right");
  }

  return getStatementSlot(
    slots,
    statementSlotIndexAt(slots, position, affinity),
  );
}

function getStatementSlot(
  slots: readonly SqlStatementSlot[],
  index: number,
): SqlStatementSlot {
  const slot = slots[index];
  if (!slot) {
    throw new Error("SQL statement index must contain at least one slot");
  }
  return slot;
}
