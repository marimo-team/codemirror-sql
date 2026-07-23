export {
  type AliasCompletionConfig,
  aliasColumnCompletionSource,
} from "./sql/alias-completion-source.js";
export {
  createCteCompletionSource,
  type CteCompletionConfig,
  cteCompletionSource,
} from "./sql/cte-completion-source.js";
export { type SqlLinterConfig, sqlLinter } from "./sql/diagnostics.js";
export { type SqlExtensionConfig, sqlExtension } from "./sql/extension.js";
export type {
  KeywordTooltipData,
  NamespaceTooltipData,
  SqlHoverConfig,
  SqlKeywordInfo,
} from "./sql/hover.js";
export { DefaultSqlTooltipRenders, defaultSqlHoverTheme, sqlHover } from "./sql/hover.js";
export {
  gotoSqlDefinition,
  renameSqlIdentifier,
  type SqlNavigationConfig,
  sqlGotoDefinition,
  sqlHighlightReferences,
  sqlNavigation,
  sqlNavigationKeymap,
} from "./sql/navigation-extension.js";
export {
  NodeSqlParser,
  type NodeSqlParserOptions,
  type NodeSqlParserResult,
  type ParserOption,
  type SupportedDialects,
} from "./sql/parser.js";
export {
  analyzeQueryContext,
  type QueryContext,
  QueryContextAnalyzer,
  type QueryContextCte,
  type QueryContextTable,
} from "./sql/query-context.js";
export {
  findReferences,
  type SqlIdentifierKind,
  type SqlRange,
  type SqlReferenceConfig,
  SqlReferenceResolver,
  type SqlReferenceResult,
} from "./sql/references.js";
export { resolveSqlSchema, type SqlSchemaSource, sqlSchemaFacet } from "./sql/schema-facet.js";
export {
  type SemanticSeverity,
  type SqlSemanticLinterConfig,
  sqlSemanticLinter,
} from "./sql/semantic-diagnostics.js";
export type { SqlStatement } from "./sql/structure-analyzer.js";
export { SqlStructureAnalyzer } from "./sql/structure-analyzer.js";
export type { SqlGutterConfig } from "./sql/structure-extension.js";
export { sqlStructureGutter } from "./sql/structure-extension.js";
export type { SqlParseError, SqlParseResult, SqlParser } from "./sql/types.js";
