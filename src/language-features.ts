import type {
  SqlDocumentContext,
  SqlEmbeddedRegion,
  SqlRevision,
  SqlTextChange,
  SqlTextRange,
} from "./types.js";

export const MAX_SQL_FEATURE_RESULTS = 1_000;
export const MAX_SQL_FEATURE_TEXT_LENGTH = 8_192;

export type SqlDiagnosticSeverity =
  | "error"
  | "warning"
  | "information"
  | "hint";

export interface SqlDiagnostic extends SqlTextRange {
  readonly code?: string | undefined;
  readonly message: string;
  readonly severity: SqlDiagnosticSeverity;
  readonly source: string;
}

export interface SqlMarkupContent {
  readonly kind: "plaintext" | "markdown";
  readonly value: string;
}

export interface SqlHover {
  readonly contents: SqlMarkupContent;
  readonly range: SqlTextRange;
}

export interface SqlLocation {
  readonly range: SqlTextRange;
  readonly uri?: string | undefined;
}

export type SqlDocumentSymbolKind =
  | "statement"
  | "relation"
  | "column"
  | "function"
  | "parameter";

export interface SqlDocumentSymbol {
  readonly detail?: string | undefined;
  readonly kind: SqlDocumentSymbolKind;
  readonly name: string;
  readonly range: SqlTextRange;
  readonly selectionRange: SqlTextRange;
}

export interface SqlFoldingRange extends SqlTextRange {
  readonly kind?: "statement" | "region" | "comment" | undefined;
}

export interface SqlDocumentEditResult {
  readonly changes: readonly SqlTextChange[];
}

export interface SqlCodeAction {
  readonly diagnostics?: readonly string[] | undefined;
  readonly edit?: SqlDocumentEditResult | undefined;
  readonly kind?: "quickfix" | "refactor" | "source" | undefined;
  readonly title: string;
}

export interface SqlPositionFeatureRequest {
  readonly position: number;
  readonly signal?: AbortSignal | undefined;
}

export interface SqlRangeFeatureRequest {
  readonly range: SqlTextRange;
  readonly signal?: AbortSignal | undefined;
}

export interface SqlDiagnosticsRequest {
  readonly range?: SqlTextRange | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SqlRenameRequest extends SqlPositionFeatureRequest {
  readonly newName: string;
}

export interface SqlFormatRequest {
  readonly range?: SqlTextRange | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly tabSize?: number | undefined;
  readonly useTabs?: boolean | undefined;
}

export interface SqlFeatureDocument<
  Context extends SqlDocumentContext = SqlDocumentContext,
> {
  readonly context: Context;
  readonly dialect: string;
  readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  readonly text: string;
}

export interface SqlFeatureProviderRequest<
  Request,
  Context extends SqlDocumentContext = SqlDocumentContext,
> {
  readonly document: SqlFeatureDocument<Context>;
  readonly request: Omit<Request, "signal">;
  readonly signal: AbortSignal;
}

export interface SqlLanguageFeatureProvider<
  Context extends SqlDocumentContext = SqlDocumentContext,
> {
  readonly id: string;
  readonly codeActions?: (
    input: SqlFeatureProviderRequest<SqlRangeFeatureRequest, Context>,
  ) => PromiseLike<readonly SqlCodeAction[]> | readonly SqlCodeAction[];
  readonly definitions?: (
    input: SqlFeatureProviderRequest<SqlPositionFeatureRequest, Context>,
  ) => PromiseLike<readonly SqlLocation[]> | readonly SqlLocation[];
  readonly diagnostics?: (
    input: SqlFeatureProviderRequest<SqlDiagnosticsRequest, Context>,
  ) => PromiseLike<readonly SqlDiagnostic[]> | readonly SqlDiagnostic[];
  readonly documentSymbols?: (
    input: SqlFeatureProviderRequest<object, Context>,
  ) => PromiseLike<readonly SqlDocumentSymbol[]> | readonly SqlDocumentSymbol[];
  readonly foldingRanges?: (
    input: SqlFeatureProviderRequest<object, Context>,
  ) => PromiseLike<readonly SqlFoldingRange[]> | readonly SqlFoldingRange[];
  readonly format?: (
    input: SqlFeatureProviderRequest<SqlFormatRequest, Context>,
  ) => PromiseLike<SqlDocumentEditResult | null> | SqlDocumentEditResult | null;
  readonly highlights?: (
    input: SqlFeatureProviderRequest<SqlPositionFeatureRequest, Context>,
  ) => PromiseLike<readonly SqlTextRange[]> | readonly SqlTextRange[];
  readonly hover?: (
    input: SqlFeatureProviderRequest<SqlPositionFeatureRequest, Context>,
  ) => PromiseLike<SqlHover | null> | SqlHover | null;
  readonly references?: (
    input: SqlFeatureProviderRequest<SqlPositionFeatureRequest, Context>,
  ) => PromiseLike<readonly SqlLocation[]> | readonly SqlLocation[];
  readonly rename?: (
    input: SqlFeatureProviderRequest<SqlRenameRequest, Context>,
  ) => PromiseLike<SqlDocumentEditResult | null> | SqlDocumentEditResult | null;
}

export interface SqlFeatureProviderReport {
  readonly outcome: "ready" | "failed" | "timed-out";
  readonly providerId: string;
}

export interface SqlFeatureReady<Value> {
  readonly isIncomplete: boolean;
  readonly revision: SqlRevision;
  readonly sources: readonly SqlFeatureProviderReport[];
  readonly status: "ready";
  readonly value: Value;
}

export interface SqlFeatureCancelled {
  readonly reason: "caller" | "disposed" | "superseded";
  readonly revision: SqlRevision;
  readonly status: "cancelled";
}

export interface SqlFeatureUnavailable {
  readonly reason: "no-provider" | "no-result";
  readonly revision: SqlRevision;
  readonly sources: readonly SqlFeatureProviderReport[];
  readonly status: "unavailable";
}

export type SqlFeatureResult<Value> =
  | SqlFeatureReady<Value>
  | SqlFeatureCancelled
  | SqlFeatureUnavailable;

export interface SqlFeatureTask<Value> {
  readonly cancel: () => void;
  readonly result: Promise<SqlFeatureResult<Value>>;
}

export interface SqlLanguageFeatureMethods {
  readonly codeActions: (
    request: SqlRangeFeatureRequest,
  ) => SqlFeatureTask<readonly SqlCodeAction[]>;
  readonly definitions: (
    request: SqlPositionFeatureRequest,
  ) => SqlFeatureTask<readonly SqlLocation[]>;
  readonly diagnostics: (
    request?: SqlDiagnosticsRequest,
  ) => SqlFeatureTask<readonly SqlDiagnostic[]>;
  readonly documentSymbols: () => SqlFeatureTask<
    readonly SqlDocumentSymbol[]
  >;
  readonly foldingRanges: () => SqlFeatureTask<
    readonly SqlFoldingRange[]
  >;
  readonly format: (
    request?: SqlFormatRequest,
  ) => SqlFeatureTask<SqlDocumentEditResult>;
  readonly highlights: (
    request: SqlPositionFeatureRequest,
  ) => SqlFeatureTask<readonly SqlTextRange[]>;
  readonly hover: (
    request: SqlPositionFeatureRequest,
  ) => SqlFeatureTask<SqlHover>;
  readonly references: (
    request: SqlPositionFeatureRequest,
  ) => SqlFeatureTask<readonly SqlLocation[]>;
  readonly rename: (
    request: SqlRenameRequest,
  ) => SqlFeatureTask<SqlDocumentEditResult>;
}
