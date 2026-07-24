import type {
  SqlOpaqueBoundaryReason,
  SqlUnterminatedConstruct,
} from "./statement-index.js";

const statementRangeBrand: unique symbol = Symbol(
  "SqlStatementRelativeRange",
);
const syntaxArtifactBrand: unique symbol = Symbol("SqlSyntaxArtifact");
const parserDiagnosticBrand: unique symbol = Symbol(
  "SqlParserDiagnostic",
);
const parserAnalysisBrand: unique symbol = Symbol("SqlParserAnalysis");
const syntaxStateBrand: unique symbol = Symbol(
  "SqlStatementSyntaxState",
);
const parserRequestBrand: unique symbol = Symbol(
  "SqlStatementParseRequest",
);
const statementParserBrand: unique symbol = Symbol(
  "SqlStatementParser",
);
const backendIdentityBrand: unique symbol = Symbol(
  "SqlSyntaxBackendIdentity",
);
const configurationIdentityBrand: unique symbol = Symbol(
  "SqlSyntaxConfigurationIdentity",
);
const dialectIdentityBrand: unique symbol = Symbol(
  "SqlDialectSyntaxIdentity",
);
const conformanceIdentityBrand: unique symbol = Symbol(
  "SqlConformanceIdentity",
);
const parserAuthorityBrand: unique symbol = Symbol(
  "SqlParserAuthority",
);

export const MAX_SQL_SYNTAX_DIAGNOSTICS = 64;
export const MAX_SQL_SYNTAX_MESSAGE_LENGTH = 2_048;
export const MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH = 8_192;
export const MAX_SQL_STATEMENT_PARSE_LENGTH = 1024 * 1024;
export const MAX_SQL_COMPATIBILITY_LIMITATIONS = 3;

const statementRanges = new WeakSet<object>();
const syntaxArtifacts = new WeakSet<object>();
const parserDiagnostics = new WeakSet<object>();
const parserAnalyses = new WeakSet<object>();
const statementSyntaxStates = new WeakSet<object>();
const parserRequests = new WeakSet<object>();
const statementParsers = new WeakSet<object>();
const backendIdentities = new WeakSet<object>();
const configurationIdentities = new WeakSet<object>();
const dialectIdentities = new WeakSet<object>();
const conformanceIdentities = new WeakSet<object>();
const parserAuthorities = new WeakSet<object>();
const conformanceAuthorities = new WeakMap<
  SqlConformanceIdentity,
  SqlParserAuthority
>();
const artifactSources = new WeakMap<SqlSyntaxArtifact, string>();
const artifactAuthorities = new WeakMap<
  SqlSyntaxArtifact,
  SqlParserAuthority
>();
const diagnosticSources = new WeakMap<
  SqlParserDiagnostic,
  string
>();
const diagnosticAuthorities = new WeakMap<
  SqlParserDiagnostic,
  SqlParserAuthority
>();
const analysisSources = new WeakMap<
  SqlParserAnalysis,
  string
>();
const analysisAuthorities = new WeakMap<
  SqlParserAnalysis,
  SqlParserAuthority
>();
const parserCallbacks = new WeakMap<
  SqlStatementParser,
  SqlStatementParserCallback
>();

export type SqlSyntaxContractErrorCode =
  | "invalid-analysis"
  | "invalid-artifact"
  | "invalid-diagnostic"
  | "invalid-identity"
  | "invalid-range"
  | "invalid-request";

export class SqlSyntaxContractError extends Error {
  readonly code: SqlSyntaxContractErrorCode;

  constructor(code: SqlSyntaxContractErrorCode, message: string) {
    super(message);
    this.name = "SqlSyntaxContractError";
    this.code = code;
  }
}

export interface SqlStatementRelativeRange {
  readonly [statementRangeBrand]: "SqlStatementRelativeRange";
  readonly from: number;
  readonly to: number;
}

function requireStatementLength(
  value: unknown,
  code: SqlSyntaxContractErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SqlSyntaxContractError(
      code,
      "SQL statement length must be a non-negative safe integer",
    );
  }
  return Number(value);
}

function requireStatementText(
  value: unknown,
  code: SqlSyntaxContractErrorCode,
): string {
  if (typeof value !== "string") {
    throw new SqlSyntaxContractError(
      code,
      "SQL statement text must be a string",
    );
  }
  if (value.length > MAX_SQL_STATEMENT_PARSE_LENGTH) {
    throw new SqlSyntaxContractError(
      code,
      "SQL statement text exceeds the parser input limit",
    );
  }
  return value;
}

export function createSqlStatementRelativeRange(
  from: unknown,
  to: unknown,
  statementLength: unknown,
): SqlStatementRelativeRange {
  const length = requireStatementLength(statementLength, "invalid-range");
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    Number(from) < 0 ||
    Number(from) > Number(to) ||
    Number(to) > length
  ) {
    throw new SqlSyntaxContractError(
      "invalid-range",
      "SQL statement range must be an in-bounds half-open UTF-16 range",
    );
  }
  const range: SqlStatementRelativeRange = {
    [statementRangeBrand]: "SqlStatementRelativeRange",
    from: Number(from),
    to: Number(to),
  };
  Object.freeze(range);
  statementRanges.add(range);
  return range;
}

function isAuthenticStatementRange(
  value: unknown,
): value is SqlStatementRelativeRange {
  return (
    value !== null &&
    typeof value === "object" &&
    statementRanges.has(value)
  );
}

function requireStatementRange(
  range: unknown,
  statementLength: number,
  code: SqlSyntaxContractErrorCode,
): SqlStatementRelativeRange {
  if (!isAuthenticStatementRange(range)) {
    throw new SqlSyntaxContractError(
      code,
      "SQL statement range must be created by this syntax contract",
    );
  }
  if (range.to > statementLength) {
    throw new SqlSyntaxContractError(
      code,
      "SQL statement range exceeds the current statement",
    );
  }
  return range;
}

export interface SqlSyntaxBackendIdentity {
  readonly [backendIdentityBrand]: "SqlSyntaxBackendIdentity";
}

export interface SqlSyntaxConfigurationIdentity {
  readonly [configurationIdentityBrand]: "SqlSyntaxConfigurationIdentity";
}

export interface SqlDialectSyntaxIdentity {
  readonly [dialectIdentityBrand]: "SqlDialectSyntaxIdentity";
}

export interface SqlConformanceIdentity {
  readonly [conformanceIdentityBrand]: "SqlConformanceIdentity";
}

export interface SqlParserAuthority {
  readonly [parserAuthorityBrand]: "SqlParserAuthority";
  readonly backendIdentity: SqlSyntaxBackendIdentity;
  readonly configurationIdentity: SqlSyntaxConfigurationIdentity;
  readonly dialectIdentity: SqlDialectSyntaxIdentity;
}

export function createSqlSyntaxBackendIdentity(): SqlSyntaxBackendIdentity {
  const identity: SqlSyntaxBackendIdentity = {
    [backendIdentityBrand]: "SqlSyntaxBackendIdentity",
  };
  Object.freeze(identity);
  backendIdentities.add(identity);
  return identity;
}

export function createSqlSyntaxConfigurationIdentity(): SqlSyntaxConfigurationIdentity {
  const identity: SqlSyntaxConfigurationIdentity = {
    [configurationIdentityBrand]: "SqlSyntaxConfigurationIdentity",
  };
  Object.freeze(identity);
  configurationIdentities.add(identity);
  return identity;
}

export function createSqlDialectSyntaxIdentity(): SqlDialectSyntaxIdentity {
  const identity: SqlDialectSyntaxIdentity = {
    [dialectIdentityBrand]: "SqlDialectSyntaxIdentity",
  };
  Object.freeze(identity);
  dialectIdentities.add(identity);
  return identity;
}

export function createSqlParserAuthority(
  backendIdentity: SqlSyntaxBackendIdentity,
  configurationIdentity: SqlSyntaxConfigurationIdentity,
  dialectIdentity: SqlDialectSyntaxIdentity,
): SqlParserAuthority {
  requireIdentity(backendIdentity, backendIdentities);
  requireIdentity(configurationIdentity, configurationIdentities);
  requireIdentity(dialectIdentity, dialectIdentities);
  const authority: SqlParserAuthority = {
    [parserAuthorityBrand]: "SqlParserAuthority",
    backendIdentity,
    configurationIdentity,
    dialectIdentity,
  };
  Object.freeze(authority);
  parserAuthorities.add(authority);
  return authority;
}

export function createSqlConformanceIdentity(
  authority: SqlParserAuthority,
): SqlConformanceIdentity {
  requireIdentity(authority, parserAuthorities);
  const identity: SqlConformanceIdentity = {
    [conformanceIdentityBrand]: "SqlConformanceIdentity",
  };
  Object.freeze(identity);
  conformanceIdentities.add(identity);
  conformanceAuthorities.set(identity, authority);
  return identity;
}

function requireIdentity(
  identity: object,
  identities: WeakSet<object>,
): void {
  if (!identities.has(identity)) {
    throw new SqlSyntaxContractError(
      "invalid-identity",
      "SQL syntax identity must be created by this syntax contract",
    );
  }
}

export type SqlStatementKind =
  | "alter"
  | "create"
  | "delete"
  | "drop"
  | "insert"
  | "merge"
  | "other"
  | "query"
  | "transaction"
  | "update";

function isStatementKind(value: unknown): value is SqlStatementKind {
  switch (value) {
    case "alter":
    case "create":
    case "delete":
    case "drop":
    case "insert":
    case "merge":
    case "other":
    case "query":
    case "transaction":
    case "update":
      return true;
    default:
      return false;
  }
}

export interface SqlSyntaxArtifact {
  readonly [syntaxArtifactBrand]: "SqlSyntaxArtifact";
  readonly kind: SqlStatementKind;
  readonly range: SqlStatementRelativeRange;
}

export function createSqlSyntaxArtifact(
  kind: unknown,
  statementText: unknown,
  authority: SqlParserAuthority,
): SqlSyntaxArtifact {
  requireIdentity(authority, parserAuthorities);
  const text = requireStatementText(
    statementText,
    "invalid-artifact",
  );
  if (!isStatementKind(kind)) {
    throw new SqlSyntaxContractError(
      "invalid-artifact",
      "SQL statement kind is not supported by the syntax contract",
    );
  }
  const artifact: SqlSyntaxArtifact = {
    [syntaxArtifactBrand]: "SqlSyntaxArtifact",
    kind,
    range: createSqlStatementRelativeRange(
      0,
      text.length,
      text.length,
    ),
  };
  Object.freeze(artifact);
  syntaxArtifacts.add(artifact);
  artifactSources.set(artifact, text);
  artifactAuthorities.set(artifact, authority);
  return artifact;
}

interface SqlArtifactMetadata {
  readonly authority: SqlParserAuthority;
  readonly source: string;
}

function requireSyntaxArtifact(
  artifact: SqlSyntaxArtifact,
): SqlArtifactMetadata {
  const source = artifactSources.get(artifact);
  const authority = artifactAuthorities.get(artifact);
  if (
    !syntaxArtifacts.has(artifact) ||
    source === undefined ||
    authority === undefined
  ) {
    throw new SqlSyntaxContractError(
      "invalid-artifact",
      "SQL syntax artifact must be created by this syntax contract",
    );
  }
  return { authority, source };
}

export type SqlParserLocation =
  | {
      readonly availability: "exact";
      readonly range: SqlStatementRelativeRange;
    }
  | {
      readonly availability: "unavailable";
      readonly reason: "not-reported";
    };

const LOCATION_NOT_REPORTED: Extract<
  SqlParserLocation,
  { readonly availability: "unavailable" }
> = Object.freeze({
  availability: "unavailable",
  reason: "not-reported",
});

export interface SqlParserDiagnostic {
  readonly [parserDiagnosticBrand]: "SqlParserDiagnostic";
  readonly code: "syntax-error";
  readonly location: SqlParserLocation;
  readonly message: string;
  readonly severity: "error";
}

function normalizeMessage(
  value: unknown,
  code: SqlSyntaxContractErrorCode,
): string {
  if (typeof value !== "string") {
    throw new SqlSyntaxContractError(
      code,
      "SQL syntax message must be a string",
    );
  }
  if (value.length > MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH) {
    throw new SqlSyntaxContractError(
      code,
      "SQL syntax message exceeds the contract input limit",
    );
  }
  const message = value.trim();
  if (message.length === 0) {
    throw new SqlSyntaxContractError(
      code,
      "SQL syntax message cannot be empty",
    );
  }
  return message.slice(0, MAX_SQL_SYNTAX_MESSAGE_LENGTH);
}

export function createSqlParserDiagnostic(
  message: unknown,
  location: unknown,
  statementText: unknown,
  authority: SqlParserAuthority,
): SqlParserDiagnostic {
  requireIdentity(authority, parserAuthorities);
  const text = requireStatementText(
    statementText,
    "invalid-diagnostic",
  );
  const normalizedLocation: SqlParserLocation =
    location === null
      ? LOCATION_NOT_REPORTED
      : Object.freeze({
        availability: "exact",
        range: requireStatementRange(
          location,
          text.length,
          "invalid-diagnostic",
        ),
      });
  const diagnostic: SqlParserDiagnostic = {
    [parserDiagnosticBrand]: "SqlParserDiagnostic",
    code: "syntax-error",
    location: normalizedLocation,
    message: normalizeMessage(message, "invalid-diagnostic"),
    severity: "error",
  };
  Object.freeze(diagnostic);
  parserDiagnostics.add(diagnostic);
  diagnosticSources.set(diagnostic, text);
  diagnosticAuthorities.set(diagnostic, authority);
  return diagnostic;
}

function copyDiagnostics(
  diagnostics: readonly SqlParserDiagnostic[],
  requireNonEmpty: boolean,
): readonly SqlParserDiagnostic[] {
  const count = Array.isArray(diagnostics)
    ? diagnostics.length
    : -1;
  if (
    count < 0 ||
    count > MAX_SQL_SYNTAX_DIAGNOSTICS ||
    (requireNonEmpty && count === 0)
  ) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      requireNonEmpty
        ? "SQL invalid analysis requires bounded non-empty diagnostics"
        : "SQL syntax diagnostics exceed the contract limit",
    );
  }
  const copy: SqlParserDiagnostic[] = [];
  for (let index = 0; index < count; index += 1) {
    const diagnostic = diagnostics[index];
    if (
      diagnostic === undefined ||
      !parserDiagnostics.has(diagnostic)
    ) {
      throw new SqlSyntaxContractError(
        "invalid-analysis",
        "SQL parser diagnostic must be created by this syntax contract",
      );
    }
    copy.push(diagnostic);
  }
  return Object.freeze(copy);
}

export type SqlCompatibilityLimitation =
  | "dialect-compatibility"
  | "partial-artifact"
  | "recovered";

export type SqlParserUnsupportedReason =
  | "backend-capability"
  | "compatibility-rejected"
  | "resource-limit"
  | "uncovered-construct";

export type SqlParserFailureReason =
  | "backend-failure"
  | "malformed-output";

interface SqlParserAnalysisIdentity {
  readonly [parserAnalysisBrand]: "SqlParserAnalysis";
}

export type SqlParserAnalysis = SqlParserAnalysisIdentity &
  (
    | {
      readonly status: "parsed";
      readonly mode: "direct";
      readonly conformance: SqlConformanceIdentity;
      readonly artifact: SqlSyntaxArtifact;
    }
    | {
      readonly status: "parsed";
      readonly mode: "compatibility";
      readonly artifact: SqlSyntaxArtifact;
      readonly limitations: readonly [
        SqlCompatibilityLimitation,
        ...SqlCompatibilityLimitation[],
      ];
    }
    | {
      readonly status: "invalid";
      readonly conformance: SqlConformanceIdentity;
      readonly diagnostics: readonly [
        SqlParserDiagnostic,
        ...SqlParserDiagnostic[],
      ];
    }
    | {
      readonly status: "unsupported";
      readonly reason: SqlParserUnsupportedReason;
    }
    | {
      readonly status: "failed";
      readonly reason: SqlParserFailureReason;
      readonly message: string;
      readonly retryable: boolean;
    }
  );

function recordAnalysis<Analysis extends SqlParserAnalysis>(
  analysis: Analysis,
  source: string,
  authority: SqlParserAuthority,
): Analysis {
  Object.freeze(analysis);
  parserAnalyses.add(analysis);
  analysisSources.set(analysis, source);
  analysisAuthorities.set(analysis, authority);
  return analysis;
}

export function createDirectParsedAnalysis(
  conformance: SqlConformanceIdentity,
  artifact: SqlSyntaxArtifact,
): Extract<
  SqlParserAnalysis,
  { readonly mode: "direct"; readonly status: "parsed" }
> {
  requireIdentity(conformance, conformanceIdentities);
  const metadata = requireSyntaxArtifact(artifact);
  if (conformanceAuthorities.get(conformance) !== metadata.authority) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL conformance and artifact authority must match",
    );
  }
  return recordAnalysis(
    {
      [parserAnalysisBrand]: "SqlParserAnalysis",
      artifact,
      conformance,
      mode: "direct",
      status: "parsed",
    },
    metadata.source,
    metadata.authority,
  );
}

export function createCompatibilityParsedAnalysis(
  artifact: SqlSyntaxArtifact,
  limitations: readonly SqlCompatibilityLimitation[],
): Extract<
  SqlParserAnalysis,
  { readonly mode: "compatibility"; readonly status: "parsed" }
> {
  const metadata = requireSyntaxArtifact(artifact);
  if (
    !Array.isArray(limitations) ||
    limitations.length === 0 ||
    limitations.length > MAX_SQL_COMPATIBILITY_LIMITATIONS
  ) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL compatibility analysis requires bounded non-empty limitations",
    );
  }
  const copy: SqlCompatibilityLimitation[] = [];
  const seen = new Set<SqlCompatibilityLimitation>();
  const limitationCount = limitations.length;
  for (let index = 0; index < limitationCount; index += 1) {
    const limitation = limitations[index];
    if (
      limitation !== "dialect-compatibility" &&
      limitation !== "partial-artifact" &&
      limitation !== "recovered"
    ) {
      throw new SqlSyntaxContractError(
        "invalid-analysis",
        "SQL compatibility limitation is invalid",
      );
    }
    if (seen.has(limitation)) {
      throw new SqlSyntaxContractError(
        "invalid-analysis",
        "SQL compatibility limitations cannot contain duplicates",
      );
    }
    seen.add(limitation);
    copy.push(limitation);
  }
  const first = copy[0];
  if (first === undefined) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL compatibility analysis requires at least one limitation",
    );
  }
  const nonEmpty: [
    SqlCompatibilityLimitation,
    ...SqlCompatibilityLimitation[],
  ] = [first, ...copy.slice(1)];
  return recordAnalysis(
    {
      [parserAnalysisBrand]: "SqlParserAnalysis",
      artifact,
      limitations: Object.freeze(nonEmpty),
      mode: "compatibility",
      status: "parsed",
    },
    metadata.source,
    metadata.authority,
  );
}

export function createInvalidParserAnalysis(
  conformance: SqlConformanceIdentity,
  diagnostics: readonly SqlParserDiagnostic[],
): Extract<SqlParserAnalysis, { readonly status: "invalid" }> {
  requireIdentity(conformance, conformanceIdentities);
  const copy = copyDiagnostics(diagnostics, true);
  const first = copy[0];
  if (first === undefined) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL invalid analysis requires at least one diagnostic",
    );
  }
  const source = diagnosticSources.get(first);
  const authority = diagnosticAuthorities.get(first);
  if (source === undefined || authority === undefined) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL parser diagnostic is missing statement metadata",
    );
  }
  for (const diagnostic of copy) {
    if (diagnosticSources.get(diagnostic) !== source) {
      throw new SqlSyntaxContractError(
        "invalid-analysis",
        "SQL parser diagnostics must describe the same statement text",
      );
    }
    if (diagnosticAuthorities.get(diagnostic) !== authority) {
      throw new SqlSyntaxContractError(
        "invalid-analysis",
        "SQL parser diagnostics must share parser authority",
      );
    }
  }
  if (conformanceAuthorities.get(conformance) !== authority) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL conformance and diagnostic authority must match",
    );
  }
  const nonEmpty: [
    SqlParserDiagnostic,
    ...SqlParserDiagnostic[],
  ] = [first, ...copy.slice(1)];
  return recordAnalysis(
    {
      [parserAnalysisBrand]: "SqlParserAnalysis",
      conformance,
      diagnostics: Object.freeze(nonEmpty),
      status: "invalid",
    },
    source,
    authority,
  );
}

export function createUnsupportedParserAnalysis(
  reason: SqlParserUnsupportedReason,
  statementText: unknown,
  authority: SqlParserAuthority,
): Extract<SqlParserAnalysis, { readonly status: "unsupported" }> {
  requireIdentity(authority, parserAuthorities);
  const source = requireStatementText(
    statementText,
    "invalid-analysis",
  );
  if (
    reason !== "backend-capability" &&
    reason !== "compatibility-rejected" &&
    reason !== "resource-limit" &&
    reason !== "uncovered-construct"
  ) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL parser unsupported reason is invalid",
    );
  }
  return recordAnalysis(
    {
      [parserAnalysisBrand]: "SqlParserAnalysis",
      reason,
      status: "unsupported",
    },
    source,
    authority,
  );
}

export function createFailedParserAnalysis(
  reason: SqlParserFailureReason,
  message: unknown,
  retryable: unknown,
  statementText: unknown,
  authority: SqlParserAuthority,
): Extract<SqlParserAnalysis, { readonly status: "failed" }> {
  requireIdentity(authority, parserAuthorities);
  const source = requireStatementText(
    statementText,
    "invalid-analysis",
  );
  if (
    reason !== "backend-failure" &&
    reason !== "malformed-output"
  ) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL parser failure reason is invalid",
    );
  }
  if (typeof retryable !== "boolean") {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL parser failure retryability must be a boolean",
    );
  }
  return recordAnalysis(
    {
      [parserAnalysisBrand]: "SqlParserAnalysis",
      message: normalizeMessage(message, "invalid-analysis"),
      reason,
      retryable,
      status: "failed",
    },
    source,
    authority,
  );
}

export type SqlSyntaxUnavailableReason =
  | "dialect-not-supported"
  | "parser-not-configured";

interface SqlStatementSyntaxStateIdentity {
  readonly [syntaxStateBrand]: "SqlStatementSyntaxState";
}

export type SqlStatementSyntaxState = SqlStatementSyntaxStateIdentity &
  (
    | {
      readonly state: "empty";
    }
    | {
      readonly state: "incomplete";
      readonly construct: SqlUnterminatedConstruct;
      readonly opening: SqlStatementRelativeRange;
    }
    | {
      readonly state: "opaque";
      readonly at: SqlStatementRelativeRange;
      readonly reason: SqlOpaqueBoundaryReason;
    }
    | {
      readonly state: "unavailable";
      readonly reason: SqlSyntaxUnavailableReason;
    }
    | {
      readonly state: "analyzed";
      readonly analysis: SqlParserAnalysis;
    }
  );

function recordSyntaxState<State extends SqlStatementSyntaxState>(
  state: State,
): State {
  Object.freeze(state);
  statementSyntaxStates.add(state);
  return state;
}

function isUnterminatedConstruct(
  value: unknown,
): value is SqlUnterminatedConstruct {
  switch (value) {
    case "backtick-quoted-identifier":
    case "block-comment":
    case "dollar-quoted-string":
    case "double-quoted-identifier":
    case "double-quoted-string":
    case "single-quoted-string":
    case "triple-double-quoted-string":
    case "triple-single-quoted-string":
      return true;
    default:
      return false;
  }
}

function isOpaqueBoundaryReason(
  value: unknown,
): value is SqlOpaqueBoundaryReason {
  return (
    value === "custom-delimiter" ||
    value === "procedural-block" ||
    value === "resource-limit"
  );
}

export function createEmptySyntaxState(): Extract<
  SqlStatementSyntaxState,
  { readonly state: "empty" }
> {
  return recordSyntaxState({
    [syntaxStateBrand]: "SqlStatementSyntaxState",
    state: "empty",
  });
}

export function createIncompleteSyntaxState(
  construct: unknown,
  opening: SqlStatementRelativeRange,
  statementLength: unknown,
): Extract<
  SqlStatementSyntaxState,
  { readonly state: "incomplete" }
> {
  const length = requireStatementLength(
    statementLength,
    "invalid-analysis",
  );
  if (!isUnterminatedConstruct(construct)) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL incomplete construct is invalid",
    );
  }
  return recordSyntaxState({
    [syntaxStateBrand]: "SqlStatementSyntaxState",
    construct,
    opening: requireStatementRange(
      opening,
      length,
      "invalid-analysis",
    ),
    state: "incomplete",
  });
}

export function createOpaqueSyntaxState(
  reason: unknown,
  at: SqlStatementRelativeRange,
  statementLength: unknown,
): Extract<
  SqlStatementSyntaxState,
  { readonly state: "opaque" }
> {
  const length = requireStatementLength(
    statementLength,
    "invalid-analysis",
  );
  if (!isOpaqueBoundaryReason(reason)) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL opaque boundary reason is invalid",
    );
  }
  return recordSyntaxState({
    [syntaxStateBrand]: "SqlStatementSyntaxState",
    at: requireStatementRange(at, length, "invalid-analysis"),
    reason,
    state: "opaque",
  });
}

export function createUnavailableSyntaxState(
  reason: unknown,
): Extract<
  SqlStatementSyntaxState,
  { readonly state: "unavailable" }
> {
  if (
    reason !== "dialect-not-supported" &&
    reason !== "parser-not-configured"
  ) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL syntax unavailability reason is invalid",
    );
  }
  return recordSyntaxState({
    [syntaxStateBrand]: "SqlStatementSyntaxState",
    reason,
    state: "unavailable",
  });
}

function createAnalyzedSyntaxState(
  analysis: SqlParserAnalysis,
): Extract<
  SqlStatementSyntaxState,
  { readonly state: "analyzed" }
> {
  if (!parserAnalyses.has(analysis)) {
    throw new SqlSyntaxContractError(
      "invalid-analysis",
      "SQL parser analysis must be created by this syntax contract",
    );
  }
  return recordSyntaxState({
    [syntaxStateBrand]: "SqlStatementSyntaxState",
    analysis,
    state: "analyzed",
  });
}

export function isSqlStatementSyntaxState(
  value: unknown,
): value is SqlStatementSyntaxState {
  return (
    value !== null &&
    typeof value === "object" &&
    statementSyntaxStates.has(value)
  );
}

export interface SqlStatementParseRequest {
  readonly [parserRequestBrand]: "SqlStatementParseRequest";
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface SqlStatementParser {
  readonly [statementParserBrand]: "SqlStatementParser";
  readonly authority: SqlParserAuthority;
}

export type SqlStatementParserCallback = (
  request: SqlStatementParseRequest,
) => Promise<SqlParserAnalysis>;

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    return (
      "aborted" in value &&
      typeof value.aborted === "boolean" &&
      "reason" in value &&
      "onabort" in value &&
      (value.onabort === null ||
        typeof value.onabort === "function") &&
      "addEventListener" in value &&
      typeof value.addEventListener === "function" &&
      "removeEventListener" in value &&
      typeof value.removeEventListener === "function" &&
      "dispatchEvent" in value &&
      typeof value.dispatchEvent === "function" &&
      "throwIfAborted" in value &&
      typeof value.throwIfAborted === "function"
    );
  } catch {
    return false;
  }
}

export function createSqlStatementParseRequest(
  text: unknown,
  signal: unknown,
): SqlStatementParseRequest {
  const statementText = requireStatementText(text, "invalid-request");
  if (!isAbortSignal(signal)) {
    throw new SqlSyntaxContractError(
      "invalid-request",
      "SQL statement parser signal must satisfy the AbortSignal contract",
    );
  }
  const request: SqlStatementParseRequest = {
    [parserRequestBrand]: "SqlStatementParseRequest",
    signal,
    text: statementText,
  };
  Object.freeze(request);
  parserRequests.add(request);
  return request;
}

export function createSqlStatementParser(
  authority: SqlParserAuthority,
  parseStatement: SqlStatementParserCallback,
): SqlStatementParser {
  requireIdentity(authority, parserAuthorities);
  if (typeof parseStatement !== "function") {
    throw new SqlSyntaxContractError(
      "invalid-request",
      "SQL statement parser requires a parse function",
    );
  }
  const parser: SqlStatementParser = {
    [statementParserBrand]: "SqlStatementParser",
    authority,
  };
  Object.freeze(parser);
  statementParsers.add(parser);
  parserCallbacks.set(parser, parseStatement);
  return parser;
}

function conformanceMatchesParser(
  conformance: SqlConformanceIdentity,
  parser: SqlStatementParser,
): boolean {
  return conformanceAuthorities.get(conformance) === parser.authority;
}

function malformedParserOutput(
  statementText: string,
  authority: SqlParserAuthority,
): Extract<
  SqlParserAnalysis,
  { readonly status: "failed" }
> {
  return createFailedParserAnalysis(
    "malformed-output",
    "SQL parser returned malformed normalized output",
    false,
    statementText,
    authority,
  );
}

export async function runSqlStatementParser(
  parser: SqlStatementParser,
  request: SqlStatementParseRequest,
): Promise<
  Extract<SqlStatementSyntaxState, { readonly state: "analyzed" }>
> {
  if (!statementParsers.has(parser) || !parserRequests.has(request)) {
    throw new SqlSyntaxContractError(
      "invalid-request",
      "SQL parser and request must be created by this syntax contract",
    );
  }
  const callback = parserCallbacks.get(parser);
  if (callback === undefined) {
    throw new SqlSyntaxContractError(
      "invalid-request",
      "SQL statement parser callback is unavailable",
    );
  }

  let analysis: unknown;
  try {
    analysis = await callback(request);
  } catch (error: unknown) {
    if (error instanceof SqlSyntaxContractError) {
      return createAnalyzedSyntaxState(
        malformedParserOutput(request.text, parser.authority),
      );
    }
    return createAnalyzedSyntaxState(
      createFailedParserAnalysis(
        "backend-failure",
        "SQL parser backend failed",
        true,
        request.text,
        parser.authority,
      ),
    );
  }
  if (!isSqlParserAnalysis(analysis)) {
    return createAnalyzedSyntaxState(
      malformedParserOutput(request.text, parser.authority),
    );
  }

  const source = analysisSources.get(analysis);
  if (
    source === undefined ||
    source !== request.text ||
    analysisAuthorities.get(analysis) !== parser.authority
  ) {
    return createAnalyzedSyntaxState(
      malformedParserOutput(request.text, parser.authority),
    );
  }
  if (
    (analysis.status === "invalid" ||
      (analysis.status === "parsed" && analysis.mode === "direct")) &&
    !conformanceMatchesParser(analysis.conformance, parser)
  ) {
    return createAnalyzedSyntaxState(
      malformedParserOutput(request.text, parser.authority),
    );
  }
  return createAnalyzedSyntaxState(analysis);
}

export function isSqlParserAnalysis(
  value: unknown,
): value is SqlParserAnalysis {
  return (
    value !== null &&
    typeof value === "object" &&
    parserAnalyses.has(value)
  );
}
