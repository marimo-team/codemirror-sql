import type {
  SqlCodeAction,
  SqlDiagnostic,
  SqlDocumentEditResult,
  SqlDocumentSymbol,
  SqlFeatureDocument,
  SqlFeatureProviderReport,
  SqlFoldingRange,
  SqlHover,
  SqlLanguageFeatureProvider,
  SqlLocation,
} from "./language-features.js";
import {
  MAX_SQL_FEATURE_RESULTS,
  MAX_SQL_FEATURE_TEXT_LENGTH,
} from "./language-features.js";
import {
  MAX_SQL_SOURCE_LENGTH,
  normalizeSqlTextRange,
} from "./source.js";
import type {
  SqlDocumentContext,
  SqlTextChange,
  SqlTextRange,
} from "./types.js";

const PROVIDER_METHODS = [
  "codeActions",
  "definitions",
  "diagnostics",
  "documentSymbols",
  "foldingRanges",
  "format",
  "highlights",
  "hover",
  "references",
  "rename",
] as const;
const MAX_SQL_FEATURE_NESTED_ITEMS = 10_000;
const MAX_SQL_FEATURE_AGGREGATE_TEXT_LENGTH = MAX_SQL_SOURCE_LENGTH;

export interface CapturedSqlLanguageFeatureProvider<
  Context extends SqlDocumentContext,
> {
  readonly provider: SqlLanguageFeatureProvider<Context>;
  readonly id: string;
}

function isSqlLanguageFeatureProvider<
  Context extends SqlDocumentContext,
>(value: object): value is SqlLanguageFeatureProvider<Context> {
  const id = ownData(value, "id");
  if (typeof id !== "string") return false;
  return PROVIDER_METHODS.every((method) => {
    const candidate = ownData(value, method);
    return candidate === undefined || typeof candidate === "function";
  });
}

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

export function captureSqlLanguageFeatureProviders<
  Context extends SqlDocumentContext,
>(
  candidates: unknown,
): readonly CapturedSqlLanguageFeatureProvider<Context>[] {
  if (candidates === undefined) return Object.freeze([]);
  if (!Array.isArray(candidates) || candidates.length > 64) {
    throw new Error("SQL feature providers must be an array of at most 64 providers");
  }
  const captured: CapturedSqlLanguageFeatureProvider<Context>[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      throw new Error("SQL feature providers must be objects");
    }
    if (!isSqlLanguageFeatureProvider<Context>(candidate)) {
      throw new Error("SQL feature provider has an invalid shape");
    }
    const id = candidate.id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 256 ||
      ids.has(id)
    ) {
      throw new Error("SQL feature provider IDs must be unique non-empty strings");
    }
    ids.add(id);
    captured.push(Object.freeze({
      id,
      provider: candidate,
    }));
  }
  return Object.freeze(captured);
}

export function createSqlFeatureDocument<
  Context extends SqlDocumentContext,
>(
  text: string,
  context: Context,
  embeddedRegions: SqlFeatureDocument<Context>["embeddedRegions"],
): SqlFeatureDocument<Context> {
  return Object.freeze({
    context,
    dialect: context.dialect,
    embeddedRegions,
    text,
  });
}

function text(value: unknown, subject: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SQL_FEATURE_TEXT_LENGTH
  ) {
    throw new Error(`${subject} must be a bounded non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, subject: string): string | undefined {
  return value === undefined ? undefined : text(value, subject);
}

function range(value: unknown, length: number, subject: string): SqlTextRange {
  return normalizeSqlTextRange(value, length, subject);
}

function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_SQL_FEATURE_RESULTS) {
    throw new Error(`${subject} must be a bounded array`);
  }
  return value;
}

function object(value: unknown, subject: string): object {
  if (value === null || typeof value !== "object") {
    throw new Error(`${subject} must be an object`);
  }
  return value;
}

function property(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`Feature result requires ${String(key)}`);
  }
  return descriptor.value;
}

export function normalizeSqlDiagnostics(
  value: unknown,
  length: number,
): readonly SqlDiagnostic[] {
  return Object.freeze(array(value, "SQL diagnostics").map((candidate) => {
    const item = object(candidate, "SQL diagnostic");
    const location = range(item, length, "SQL diagnostic range");
    const severity = property(item, "severity");
    if (
      severity !== "error" &&
      severity !== "warning" &&
      severity !== "information" &&
      severity !== "hint"
    ) {
      throw new Error("SQL diagnostic severity is invalid");
    }
    return Object.freeze({
      ...location,
      code: optionalText(ownData(item, "code"), "SQL diagnostic code"),
      message: text(property(item, "message"), "SQL diagnostic message"),
      severity,
      source: text(property(item, "source"), "SQL diagnostic source"),
    });
  }));
}

export function normalizeSqlHover(
  value: unknown,
  length: number,
): SqlHover | null {
  if (value === null) return null;
  const item = object(value, "SQL hover");
  const contents = object(property(item, "contents"), "SQL hover contents");
  const kind = property(contents, "kind");
  if (kind !== "plaintext" && kind !== "markdown") {
    throw new Error("SQL hover markup kind is invalid");
  }
  return Object.freeze({
    contents: Object.freeze({
      kind,
      value: text(property(contents, "value"), "SQL hover contents"),
    }),
    range: range(property(item, "range"), length, "SQL hover range"),
  });
}

function normalizeLocation(value: unknown, length: number): SqlLocation {
  const item = object(value, "SQL location");
  const uri = ownData(item, "uri");
  return Object.freeze({
    range: range(
      property(item, "range"),
      uri === undefined ? length : MAX_SQL_SOURCE_LENGTH,
      "SQL location range",
    ),
    uri: uri === undefined ? undefined : text(uri, "SQL location URI"),
  });
}

export function normalizeSqlLocations(
  value: unknown,
  length: number,
): readonly SqlLocation[] {
  return Object.freeze(
    array(value, "SQL locations").map((item) =>
      normalizeLocation(item, length)),
  );
}

export function normalizeSqlRanges(
  value: unknown,
  length: number,
): readonly SqlTextRange[] {
  return Object.freeze(
    array(value, "SQL ranges").map((item) =>
      range(item, length, "SQL feature range")),
  );
}

export function normalizeSqlDocumentSymbols(
  value: unknown,
  length: number,
): readonly SqlDocumentSymbol[] {
  return Object.freeze(array(value, "SQL document symbols").map((candidate) => {
    const item = object(candidate, "SQL document symbol");
    const kind = property(item, "kind");
    if (
      kind !== "statement" &&
      kind !== "relation" &&
      kind !== "column" &&
      kind !== "function" &&
      kind !== "parameter"
    ) {
      throw new Error("SQL document symbol kind is invalid");
    }
    const symbolRange = range(property(item, "range"), length, "SQL symbol range");
    const selectionRange = range(
      property(item, "selectionRange"),
      length,
      "SQL symbol selection range",
    );
    if (
      selectionRange.from < symbolRange.from ||
      selectionRange.to > symbolRange.to
    ) {
      throw new Error("SQL symbol selection must be inside its range");
    }
    return Object.freeze({
      detail: optionalText(ownData(item, "detail"), "SQL symbol detail"),
      kind,
      name: text(property(item, "name"), "SQL symbol name"),
      range: symbolRange,
      selectionRange,
    });
  }));
}

export function normalizeSqlFoldingRanges(
  value: unknown,
  length: number,
): readonly SqlFoldingRange[] {
  return Object.freeze(array(value, "SQL folding ranges").map((candidate) => {
    const item = object(candidate, "SQL folding range");
    const normalized = range(item, length, "SQL folding range");
    const kind = ownData(item, "kind");
    if (
      kind !== undefined &&
      kind !== "statement" &&
      kind !== "region" &&
      kind !== "comment"
    ) {
      throw new Error("SQL folding range kind is invalid");
    }
    return Object.freeze({ ...normalized, kind });
  }));
}

function normalizeTextChanges(
  value: unknown,
  length: number,
): readonly SqlTextChange[] {
  let insertedLength = 0;
  let removedLength = 0;
  const changes = array(value, "SQL text changes").map((candidate) => {
    const item = object(candidate, "SQL text change");
    const normalized = range(item, length, "SQL text change range");
    const insert = property(item, "insert");
    if (typeof insert !== "string" || insert.length > 16 * 1024 * 1024) {
      throw new Error("SQL text change insertion is invalid");
    }
    insertedLength += insert.length;
    removedLength += normalized.to - normalized.from;
    if (insertedLength > MAX_SQL_FEATURE_AGGREGATE_TEXT_LENGTH) {
      throw new Error("SQL text changes contain too much inserted text");
    }
    return Object.freeze({ ...normalized, insert });
  });
  let previousEnd = 0;
  for (const change of changes) {
    if (change.from < previousEnd) {
      throw new Error("SQL text changes must be ordered and non-overlapping");
    }
    previousEnd = change.to;
  }
  if (length - removedLength + insertedLength > MAX_SQL_SOURCE_LENGTH) {
    throw new Error("SQL text changes exceed the maximum document length");
  }
  return Object.freeze(changes);
}

export function normalizeSqlDocumentEdit(
  value: unknown,
  length: number,
): SqlDocumentEditResult | null {
  if (value === null) return null;
  const item = object(value, "SQL document edit");
  return Object.freeze({
    changes: normalizeTextChanges(property(item, "changes"), length),
  });
}

export function normalizeSqlCodeActions(
  value: unknown,
  length: number,
): readonly SqlCodeAction[] {
  const actions: SqlCodeAction[] = [];
  let nestedItems = 0;
  let aggregateTextLength = 0;
  for (const candidate of array(value, "SQL code actions")) {
    const item = object(candidate, "SQL code action");
    const kind = ownData(item, "kind");
    if (
      kind !== undefined &&
      kind !== "quickfix" &&
      kind !== "refactor" &&
      kind !== "source"
    ) {
      throw new Error("SQL code action kind is invalid");
    }
    const edit = ownData(item, "edit");
    const diagnostics = ownData(item, "diagnostics");
    const normalizedDiagnostics = diagnostics === undefined
      ? undefined
      : Object.freeze(
          array(diagnostics, "SQL code action diagnostics").map(
            (code) => text(code, "SQL diagnostic code"),
          ),
        );
    const normalizedEdit = edit === undefined
      ? undefined
      : normalizeSqlDocumentEdit(edit, length) ?? undefined;
    const title = text(property(item, "title"), "SQL code action title");
    nestedItems +=
      (normalizedDiagnostics?.length ?? 0) +
      (normalizedEdit?.changes.length ?? 0);
    aggregateTextLength += title.length;
    for (const diagnostic of normalizedDiagnostics ?? []) {
      aggregateTextLength += diagnostic.length;
    }
    for (const change of normalizedEdit?.changes ?? []) {
      aggregateTextLength += change.insert.length;
    }
    if (
      nestedItems > MAX_SQL_FEATURE_NESTED_ITEMS ||
      aggregateTextLength > MAX_SQL_FEATURE_AGGREGATE_TEXT_LENGTH
    ) {
      throw new Error("SQL code actions exceed the aggregate result budget");
    }
    actions.push(Object.freeze({
      diagnostics: normalizedDiagnostics,
      edit: normalizedEdit,
      kind,
      title,
    }));
  }
  return Object.freeze(actions);
}

export function composeSqlCodeActionResults(
  values: readonly (readonly SqlCodeAction[])[],
): {
  readonly isIncomplete: boolean;
  readonly value: readonly SqlCodeAction[];
} {
  const actions: SqlCodeAction[] = [];
  let nestedItems = 0;
  let aggregateTextLength = 0;
  for (const value of values) {
    for (const action of value) {
      let actionTextLength = action.title.length;
      const actionNestedItems =
        (action.diagnostics?.length ?? 0) +
        (action.edit?.changes.length ?? 0);
      for (const diagnostic of action.diagnostics ?? []) {
        actionTextLength += diagnostic.length;
      }
      for (const change of action.edit?.changes ?? []) {
        actionTextLength += change.insert.length;
      }
      if (
        actions.length === MAX_SQL_FEATURE_RESULTS ||
        nestedItems + actionNestedItems > MAX_SQL_FEATURE_NESTED_ITEMS ||
        aggregateTextLength + actionTextLength >
          MAX_SQL_FEATURE_AGGREGATE_TEXT_LENGTH
      ) {
        return Object.freeze({
          isIncomplete: true,
          value: Object.freeze(actions),
        });
      }
      actions.push(action);
      nestedItems += actionNestedItems;
      aggregateTextLength += actionTextLength;
    }
  }
  return Object.freeze({
    isIncomplete: values.some(
      (value) => value.length === MAX_SQL_FEATURE_RESULTS,
    ),
    value: Object.freeze(actions),
  });
}

export type SqlFeatureProviderInvocation<
  Context extends SqlDocumentContext,
  Request,
  Value,
> = (
  provider: SqlLanguageFeatureProvider<Context>,
  document: SqlFeatureDocument<Context>,
  request: Request,
  signal: AbortSignal,
) => PromiseLike<Value> | Value | undefined;

export interface SqlFeatureInvocationResult<Value> {
  readonly reports: readonly SqlFeatureProviderReport[];
  readonly values: readonly Value[];
}

export async function invokeSqlFeatureProviders<
  Context extends SqlDocumentContext,
  Request,
  Value,
>(
  providers: readonly CapturedSqlLanguageFeatureProvider<Context>[],
  document: SqlFeatureDocument<Context>,
  request: Request,
  signal: AbortSignal,
  budgetMs: number,
  supports: (
    provider: SqlLanguageFeatureProvider<Context>,
  ) => boolean,
  invoke: SqlFeatureProviderInvocation<Context, Request, unknown>,
  normalize: (value: unknown) => Value,
): Promise<SqlFeatureInvocationResult<Value>> {
  const timeoutMarker = Symbol("sql-feature-timeout");
  const abortMarker = Symbol("sql-feature-abort");
  const deadline = performance.now() + budgetMs;
  const providerControllers = new Set<AbortController>();
  const abortProviders = (): void => {
    for (const controller of providerControllers) controller.abort();
  };
  signal.addEventListener("abort", abortProviders, { once: true });
  if (signal.aborted) abortProviders();
  const settled = await Promise.all(providers.map(async (captured) => {
    if (signal.aborted) return null;
    let supported: boolean;
    try {
      supported = supports(captured.provider);
    } catch {
      return Object.freeze({
        report: Object.freeze({
          outcome: "failed" as const,
          providerId: captured.id,
        }),
      });
    }
    if (!supported) return null;
    if (performance.now() >= deadline) {
      return Object.freeze({
        report: Object.freeze({
          outcome: "timed-out" as const,
          providerId: captured.id,
        }),
      });
    }
    const providerController = new AbortController();
    providerControllers.add(providerController);
    if (signal.aborted) providerController.abort();
    let operation: PromiseLike<unknown> | unknown | undefined;
    try {
      operation = invoke(
        captured.provider,
        document,
        request,
        providerController.signal,
      );
    } catch {
      providerControllers.delete(providerController);
      return Object.freeze({
        report: Object.freeze({
          outcome: "failed" as const,
          providerId: captured.id,
        }),
      });
    }
    if (operation === undefined) {
      providerControllers.delete(providerController);
      return null;
    }
    const remainingBudgetMs = deadline - performance.now();
    if (remainingBudgetMs <= 0) {
      providerController.abort();
      providerControllers.delete(providerController);
      return Object.freeze({
        report: Object.freeze({
          outcome: "timed-out" as const,
          providerId: captured.id,
        }),
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMarker), remainingBudgetMs);
    });
    const aborted = new Promise<symbol>((resolve) => {
      onAbort = () => resolve(abortMarker);
      providerController.signal.addEventListener(
        "abort",
        onAbort,
        { once: true },
      );
      if (providerController.signal.aborted) onAbort();
    });
    try {
      const value = await Promise.race([
        Promise.resolve(operation),
        timeout,
        aborted,
      ]);
      if (value === abortMarker) return null;
      if (value === timeoutMarker) {
        providerController.abort();
        return Object.freeze({
          report: Object.freeze({
            outcome: "timed-out" as const,
            providerId: captured.id,
          }),
        });
      }
      return Object.freeze({
        report: Object.freeze({
          outcome: "ready" as const,
          providerId: captured.id,
        }),
        value: normalize(value),
      });
    } catch {
      return Object.freeze({
        report: Object.freeze({
          outcome: "failed" as const,
          providerId: captured.id,
        }),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) {
        providerController.signal.removeEventListener("abort", onAbort);
      }
      providerControllers.delete(providerController);
    }
  }));
  signal.removeEventListener("abort", abortProviders);
  providerControllers.clear();
  const reports: SqlFeatureProviderReport[] = [];
  const values: Value[] = [];
  for (const result of settled) {
    if (result === null) continue;
    reports.push(result.report);
    if ("value" in result) values.push(result.value);
  }
  return Object.freeze({
    reports: Object.freeze(reports),
    values: Object.freeze(values),
  });
}
