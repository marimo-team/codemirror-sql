import type { EditorState } from "@codemirror/state";
import {
  DefaultSqlTooltipRenders,
  NodeSqlParser,
  sqlExtension,
  type NamespaceTooltipData,
  type NodeSqlParserResult,
  type ParserOption,
  type SqlHoverConfig,
  type SqlParseError,
  type SqlParseResult,
  type SqlParser,
} from "@marimo-team/codemirror-sql";

export interface ConsumerResult extends SqlParseResult {
  elapsed: number;
}

export interface ConsumerNodeResult extends NodeSqlParserResult {
  elapsed: number;
}

type NamespaceItem = NamespaceTooltipData["item"];
export interface ConsumerNamespaceItem extends NamespaceItem {
  description: string;
}

const warnings: SqlParseError[] = [
  { message: "Deprecated syntax", line: 1, column: 1, severity: "warning" },
];

export const result: ConsumerResult = {
  success: Date.now() > 0,
  errors: warnings,
  ast: { custom: "AST" },
  elapsed: 10,
};

export const nodeResult: ConsumerNodeResult = {
  success: false,
  errors: warnings,
  ast: [],
  elapsed: 10,
};

export class ConsumerParser implements SqlParser {
  async parse(_sql: string, _opts: { state: EditorState }) {
    return { success: true, errors: warnings, ast: { custom: "AST" } };
  }
  async validateSql(_sql: string, _opts: { state: EditorState }) { return warnings; }
  async extractTableReferences(_sql: string) { return ["users"]; }
  async extractColumnReferences(_sql: string) { return ["id"]; }
}

export class SanitizingParser extends NodeSqlParser {
  override async sanitizeSql(sql: string, options?: ParserOption): Promise<string> {
    return super.sanitizeSql(sql.replaceAll("CUSTOM_SELECT", "SELECT"), options);
  }
}

export const config: SqlHoverConfig = { parser: new ConsumerParser() };
export const references = config.parser?.extractTableReferences("SELECT * FROM users");
export const extensions = sqlExtension({ linterConfig: { parser: new ConsumerParser() } });
export const namespace: ConsumerNamespaceItem = {
  type: "completion",
  path: ["users"],
  semanticType: "table",
  description: "A custom tooltip payload",
};
export const rendered = DefaultSqlTooltipRenders.namespace(namespace);
