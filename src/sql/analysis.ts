import type { EditorState } from "@codemirror/state";
import { NodeSqlParser } from "./parser.js";
import { QueryContextAnalyzer } from "./query-context.js";
import { SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParseResult, SqlParser, SqlParserLike } from "./types.js";
import { SqlStateCache } from "./state-cache.js";

export interface SqlAnalysisConfig {
  parser?: SqlParserLike;
  structureAnalyzer?: SqlStructureAnalyzer;
  contextAnalyzer?: QueryContextAnalyzer;
}

export interface SqlAnalysis {
  parser: SqlParser;
  structureAnalyzer: SqlStructureAnalyzer;
  contextAnalyzer: QueryContextAnalyzer;
}

class CachedSqlParser implements SqlParser {
  private cache: SqlStateCache<Map<string, Promise<SqlParseResult>>>;

  constructor(private parser: SqlParserLike) {
    this.cache = new SqlStateCache(parser);
  }

  getCacheKey(state: EditorState): unknown {
    return this.parser.getCacheKey?.(state);
  }

  parse(sql: string, opts: { state: EditorState }): Promise<SqlParseResult> {
    const cache = this.cache.get(opts.state, () => new Map());
    const existing = cache.get(sql);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => this.parser.parse(sql, opts));
    cache.set(sql, pending);
    void pending.catch(() => cache.delete(sql));
    return pending;
  }

  async validateSql(sql: string, opts: { state: EditorState }) {
    return this.parser.validateSql
      ? this.parser.validateSql(sql, opts)
      : (await this.parse(sql, opts)).errors;
  }

  async extractTableReferences(sql: string, opts?: { state: EditorState }): Promise<string[]> {
    return this.parser.extractTableReferences?.(sql, opts) ?? [];
  }

  async extractColumnReferences(sql: string, opts?: { state: EditorState }): Promise<string[]> {
    return this.parser.extractColumnReferences?.(sql, opts) ?? [];
  }
}

export function createSqlAnalysis(config: SqlAnalysisConfig = {}): SqlAnalysis {
  const parser = config.parser instanceof CachedSqlParser
    ? config.parser
    : new CachedSqlParser(config.parser ?? new NodeSqlParser());
  return {
    parser,
    structureAnalyzer: config.structureAnalyzer ?? new SqlStructureAnalyzer(parser),
    contextAnalyzer: config.contextAnalyzer ?? new QueryContextAnalyzer(parser),
  };
}
