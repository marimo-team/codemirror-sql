import type { SqlTextRange } from "../../src/vnext/index.js";
import {
  createCompatibilityParsedAnalysis,
  createDirectParsedAnalysis,
  createInvalidParserAnalysis,
  createSqlConformanceIdentity,
  createSqlParserAuthority,
  createSqlParserDiagnostic,
  createSqlStatementRelativeRange,
  createSqlStatementParser,
  createSqlStatementParseRequest,
  createSqlSyntaxArtifact,
  createSqlSyntaxBackendIdentity,
  createSqlSyntaxConfigurationIdentity,
  createSqlDialectSyntaxIdentity,
  type SqlParserAnalysis,
  runSqlStatementParser,
  type SqlStatementParser,
  type SqlStatementParseRequest,
  type SqlStatementRelativeRange,
  type SqlStatementSyntaxState,
  type SqlSyntaxArtifact,
} from "../../src/vnext/syntax.js";

const range = createSqlStatementRelativeRange(0, 8, 8);
const backendIdentity = createSqlSyntaxBackendIdentity();
const configurationIdentity = createSqlSyntaxConfigurationIdentity();
const dialectIdentity = createSqlDialectSyntaxIdentity();
const authority = createSqlParserAuthority(
  backendIdentity,
  configurationIdentity,
  dialectIdentity,
);
const conformance = createSqlConformanceIdentity(authority);
const artifact = createSqlSyntaxArtifact(
  "query",
  "SELECT 1",
  authority,
);
const diagnostic = createSqlParserDiagnostic(
  "bad",
  range,
  "SELECT 1",
  authority,
);
const direct = createDirectParsedAnalysis(conformance, artifact);
const compatibility = createCompatibilityParsedAnalysis(artifact, [
  "dialect-compatibility",
]);
const invalid = createInvalidParserAnalysis(conformance, [diagnostic]);

function describeAnalysis(analysis: SqlParserAnalysis): string {
  switch (analysis.status) {
    case "parsed":
      return analysis.mode === "direct"
        ? analysis.conformance.toString()
        : analysis.limitations.join(",");
    case "invalid":
      return analysis.diagnostics[0].message;
    case "unsupported":
      return analysis.reason;
    case "failed":
      return analysis.message;
    default: {
      const exhaustive: never = analysis;
      return exhaustive;
    }
  }
}

function describeSyntaxState(state: SqlStatementSyntaxState): string {
  switch (state.state) {
    case "empty":
      return "empty";
    case "incomplete":
      return state.construct;
    case "opaque":
      return state.reason;
    case "unavailable":
      return state.reason;
    case "analyzed":
      return describeAnalysis(state.analysis);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

declare const publicRange: SqlTextRange;
// @ts-expect-error absolute public ranges cannot become statement-relative
const relativeRange: SqlStatementRelativeRange = publicRange;
// @ts-expect-error statement-relative ranges require package construction
const fabricatedRange: SqlStatementRelativeRange = { from: 0, to: 8 };
// @ts-expect-error syntax artifacts require package construction
const fabricatedArtifact: SqlSyntaxArtifact = { kind: "query", range };
const impossibleDirect: SqlParserAnalysis = {
  status: "parsed",
  mode: "direct",
  conformance,
  artifact,
  // @ts-expect-error direct parses cannot carry compatibility limitations
  limitations: ["recovered"],
};
const impossibleCompatibility: SqlParserAnalysis = {
  status: "parsed",
  mode: "compatibility",
  artifact,
  limitations: ["recovered"],
  // @ts-expect-error compatibility parses cannot claim direct conformance
  conformance,
};
// @ts-expect-error invalid is authoritative and requires conformance
const invalidWithoutConformance: SqlParserAnalysis = {
  status: "invalid",
  diagnostics: [diagnostic],
};
const invalidWithoutDiagnostics: SqlParserAnalysis = {
  status: "invalid",
  conformance,
  // @ts-expect-error invalid requires at least one diagnostic
  diagnostics: [],
};
const cancelledAnalysis: SqlParserAnalysis = {
  // @ts-expect-error cancellation is request lifecycle, not parser analysis
  status: "cancelled",
  // @ts-expect-error cancellation reasons do not leak into parser failures
  reason: "caller",
};
const incompleteAnalysis: SqlParserAnalysis = {
  // @ts-expect-error lexical incompleteness is not a parser analysis
  status: "incomplete",
  construct: "single-quoted-string",
};
// @ts-expect-error raw ASTs are not exposed through normalized artifacts
void artifact.ast;
// @ts-expect-error backend payloads are private implementation data
void artifact.payload;

const parser = createSqlStatementParser(
  authority,
  async ({ signal, text }) => {
    void signal;
    void text;
    return direct;
  },
);
const typedParser: SqlStatementParser = parser;
const request = createSqlStatementParseRequest(
  "SELECT 1",
  new AbortController().signal,
);
const typedRequest: SqlStatementParseRequest = request;
void runSqlStatementParser(parser, request);

// @ts-expect-error parsers require package construction
const fabricatedParser: SqlStatementParser = {
  authority,
};
// @ts-expect-error parser requests require package construction
const fabricatedRequest: SqlStatementParseRequest = {
  signal: new AbortController().signal,
  text: "SELECT 1",
};

void cancelledAnalysis;
void compatibility;
void describeSyntaxState;
void fabricatedArtifact;
void fabricatedRange;
void fabricatedParser;
void fabricatedRequest;
void impossibleCompatibility;
void impossibleDirect;
void incompleteAnalysis;
void invalid;
void invalidWithoutConformance;
void invalidWithoutDiagnostics;
void parser;
void typedParser;
void typedRequest;
void relativeRange;
