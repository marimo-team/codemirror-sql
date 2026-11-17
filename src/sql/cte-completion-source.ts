import { createSqlAnalysis } from "./analysis.js";
import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import {
  type QueryContextAnalyzer,
  type QueryContextCte,
  stripIdentifierQuotes,
} from "./query-context.js";
import { statementAt } from "./references.js";
import type { SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

/**
 * Configuration for the CTE completion source
 */
export interface CteCompletionConfig {
  /** Custom SQL parser instance to use for query analysis */
  parser?: SqlParser;
  /**
   * Query-context analyzer to reuse (e.g. shared with hover and
   * `aliasColumnCompletionSource`), so each statement is only analyzed once.
   */
  contextAnalyzer?: QueryContextAnalyzer;
  /** Structure analyzer to reuse for statement boundary detection */
  structureAnalyzer?: SqlStructureAnalyzer;
}

/** Matches a (possibly quoted) identifier at the end of the text */
const QUALIFIER_PATTERN = /([\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])$/;

function isTableNamePosition(textBefore: string): boolean {
  return /\b(?:from|join)\s+$/i.test(textBefore);
}

function isBareIdentifier(name: string): boolean {
  return /^[A-Za-z_][\w$]*$/.test(name);
}

function cteNameCompletion(cte: QueryContextCte): Completion {
  return {
    label: cte.name,
    type: "variable",
    info: `Common Table Expression: ${cte.name}`,
    boost: 10,
    ...(isBareIdentifier(cte.name) ? {} : { apply: `"${cte.name}"` }),
  };
}

function cteColumnCompletions(cte: QueryContextCte): Completion[] {
  return cte.columns.map((column) => ({
    label: column,
    type: "property",
    detail: `column of ${cte.name}`,
    boost: 5,
    ...(isBareIdentifier(column) ? {} : { apply: `"${column}"` }),
  }));
}

/**
 * Creates a completion source for Common Table Expressions (CTEs), scoped to
 * the statement containing the cursor:
 * - CTE names declared in the statement's WITH clauses
 * - a CTE's output columns after `<cte>.`
 * - a CTE's output columns unqualified, when the statement selects FROM it
 *
 * Statements that don't parse (mid-edit) fall back to a regex-based scan.
 */
export function createCteCompletionSource(config: CteCompletionConfig = {}): CompletionSource {
  const { contextAnalyzer, structureAnalyzer } = createSqlAnalysis(config);

  return async (context: CompletionContext) => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word) {
      return null;
    }

    const charBefore = context.state.sliceDoc(Math.max(0, word.from - 1), word.from);
    const qualified = charBefore === ".";

    // A `<cte>.` qualifier triggers even without a typed word or explicit mode
    if (word.from === word.to && !context.explicit && !qualified) {
      return null;
    }

    // Scope the analysis to the statement containing the cursor, so CTEs from
    // other statements in a multi-statement doc don't leak in
    const statement = await statementAt(structureAnalyzer, context.state, context.pos);
    const statementSql = statement
      ? context.state.sliceDoc(statement.from, statement.to)
      : context.state.doc.toString();
    const queryContext = await contextAnalyzer.getContext(statementSql, {
      state: context.state,
    });
    if (queryContext.ctes.length === 0) {
      return null;
    }

    if (qualified) {
      const line = context.state.doc.lineAt(word.from);
      const prefix = context.state.sliceDoc(line.from, word.from - 1);
      const qualifierMatch = QUALIFIER_PATTERN.exec(prefix);
      if (!qualifierMatch || !qualifierMatch[1]) {
        return null;
      }
      // Multi-segment paths like `db.cte.` can't reference a CTE
      const beforeQualifier = prefix.slice(0, prefix.length - qualifierMatch[1].length);
      if (beforeQualifier.endsWith(".")) {
        return null;
      }
      const qualifier = stripIdentifierQuotes(qualifierMatch[1]).toLowerCase();
      const cte = queryContext.ctes.find((c) => c.name.toLowerCase() === qualifier);
      if (!cte || cte.columns.length === 0) {
        return null;
      }
      return {
        from: word.from,
        options: cteColumnCompletions(cte),
        validFor: /^[\w$]*$/,
      };
    }

    const options: Completion[] = queryContext.ctes.map(cteNameCompletion);

    // In column positions (not right after FROM/JOIN), also offer the output
    // columns of CTEs the statement actually selects from
    const textBefore = context.state.sliceDoc(Math.max(0, word.from - 64), word.from);
    if (!isTableNamePosition(textBefore)) {
      const referenced = new Set(queryContext.tables.map((table) => table.name.toLowerCase()));
      const seenColumns = new Set<string>();
      for (const cte of queryContext.ctes) {
        if (!referenced.has(cte.name.toLowerCase())) {
          continue;
        }
        for (const completion of cteColumnCompletions(cte)) {
          const key = completion.label.toLowerCase();
          if (!seenColumns.has(key)) {
            seenColumns.add(key);
            options.push(completion);
          }
        }
      }
    }

    return {
      from: word.from,
      options,
      validFor: /^[\w$]*$/,
    };
  };
}

/**
 * A completion source for Common Table Expressions (CTEs) in SQL
 *
 * This function provides autocomplete suggestions for CTE names and columns
 * based on WITH clauses in the statement containing the cursor.
 *
 * @param context The completion context from CodeMirror
 * @returns Completion result with CTE suggestions or null if no completions available
 *
 * @example
 * ```ts
 * import { cteCompletionSource } from '@marimo-team/codemirror-sql';
 * import { StandardSQL } from '@codemirror/lang-sql';
 *
 * // Add to SQL language configuration
 * StandardSQL.language.data.of({
 *   autocomplete: cteCompletionSource,
 * })
 * ```
 */
export const cteCompletionSource: CompletionSource = (() => {
  let source: CompletionSource | null = null;
  return (context: CompletionContext) => {
    source ??= createCteCompletionSource();
    return source(context);
  };
})();
