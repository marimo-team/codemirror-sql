import type { EditorState } from "@codemirror/state";
import { NodeSqlParser } from "./parser.js";
import {
  maskLiteralsAndComments,
  type QueryContext,
  QueryContextAnalyzer,
} from "./query-context.js";
import { SqlStructureAnalyzer, type SqlStatement } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

/** A document range (absolute offsets) */
export interface SqlRange {
  from: number;
  to: number;
}

/** The kinds of statement-local identifiers that can be resolved */
export type SqlIdentifierKind = "cte" | "table-alias" | "select-alias";

/**
 * Resolution of the identifier under the cursor: where it is defined and
 * every place it is used within its statement.
 */
export interface SqlReferenceResult {
  kind: SqlIdentifierKind;
  /** The identifier as declared (quotes stripped) */
  name: string;
  /** The declaration token (CTE name in WITH, alias token, select alias) */
  definition: SqlRange;
  /** All occurrences including the definition, sorted by position */
  references: SqlRange[];
}

/**
 * Shared dependencies for reference resolution. All are optional; omitted
 * pieces are created internally (pass shared instances to avoid re-parsing).
 */
export interface SqlReferenceConfig {
  parser?: SqlParser;
  structureAnalyzer?: SqlStructureAnalyzer;
  contextAnalyzer?: QueryContextAnalyzer;
}

const WORD_CHAR = /[\w$]/;

/** The bare identifier token containing (or immediately touching) `pos` */
export function identifierTokenAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let start = pos - line.from;
  let end = start;
  while (start > 0 && WORD_CHAR.test(text[start - 1] ?? "")) start--;
  while (end < text.length && WORD_CHAR.test(text[end] ?? "")) end++;
  if (start === end) {
    return null;
  }
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) };
}

/**
 * The statement containing `pos`, falling back to the closest preceding
 * statement (covers a cursor sitting in trailing whitespace).
 */
export async function statementAt(
  analyzer: SqlStructureAnalyzer,
  state: EditorState,
  pos: number,
): Promise<SqlStatement | null> {
  const statements = await analyzer.analyzeDocument(state);
  let preceding: SqlStatement | null = null;
  for (const statement of statements) {
    if (pos >= statement.from && pos <= statement.to) {
      return statement;
    }
    if (statement.from <= pos) {
      preceding = statement;
    }
  }
  return preceding;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare-or-quoted token alternatives for an identifier, for use in a RegExp */
function tokenAlternatives(name: string, opts: { allowLeadingDot?: boolean } = {}): string {
  const escaped = escapeRegExp(name);
  // The bare form must not be part of a longer identifier or (unless allowed,
  // e.g. the trailing segment of a qualified table path) a dotted path's
  // trailing segment (`x.name` is a column of `x`, not this identifier)
  const guard = opts.allowLeadingDot ? "(?<![\\w$])" : "(?<![\\w$.])";
  return `(?:"${escaped}"|\`${escaped}\`|\\[${escaped}\\]|${guard}${escaped}(?![\\w$]))`;
}

/** All occurrences of `name` (bare or quoted) in masked statement text */
function scanOccurrences(
  masked: string,
  name: string,
  opts: { followedByDot?: boolean } = {},
): SqlRange[] {
  const pattern = new RegExp(tokenAlternatives(name), "gi");
  const ranges: SqlRange[] = [];
  let match = pattern.exec(masked);
  while (match !== null) {
    const to = match.index + match[0].length;
    if (!opts.followedByDot || masked[to] === ".") {
      ranges.push({ from: match.index, to });
    }
    match = pattern.exec(masked);
  }
  return ranges;
}

/** Paren nesting depth at each character position */
function parenDepths(text: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ")") depth = Math.max(0, depth - 1);
    depths[i] = depth;
    if (text[i] === "(") depth++;
  }
  return depths;
}

function dedupeAndSort(ranges: SqlRange[]): SqlRange[] {
  const byFrom = new Map<number, SqlRange>();
  for (const range of ranges) {
    if (!byFrom.has(range.from)) {
      byFrom.set(range.from, range);
    }
  }
  return [...byFrom.values()].sort((a, b) => a.from - b.from);
}

function containsRange(ranges: SqlRange[], inner: SqlRange): boolean {
  return ranges.some((range) => range.from <= inner.from && inner.to <= range.to);
}

/** Statement-relative resolution; ranges are offsets into `statementText` */
function resolveInStatement(
  statementText: string,
  context: QueryContext,
  token: SqlRange & { text: string },
): SqlReferenceResult | null {
  const masked = maskLiteralsAndComments(statementText);
  const lower = token.text.toLowerCase();

  const cte = context.ctes.find((c) => c.name.toLowerCase() === lower);
  if (cte) {
    // A name that is also an alias for something else is ambiguous — refuse
    const aliasTarget = context.aliases.get(lower);
    if (aliasTarget && aliasTarget.toLowerCase() !== lower) {
      return null;
    }
    if (cte.from < 0) {
      return null;
    }
    const definition: SqlRange = { from: cte.from, to: cte.to };
    const references = dedupeAndSort([definition, ...scanOccurrences(masked, cte.name)]);
    if (!containsRange(references, token)) {
      return null;
    }
    return { kind: "cte", name: cte.name, definition, references };
  }

  if (context.aliases.has(lower)) {
    const owners = context.tables.filter((table) => table.alias?.toLowerCase() === lower);
    // Same alias on two different tables (e.g. sibling subqueries) — refuse
    // rather than mixing scopes
    if (owners.length !== 1 || !owners[0]) {
      return null;
    }
    const owner = owners[0];
    const alias = owner.alias ?? token.text;
    // The definition is the alias token right after its table reference (the
    // table may be the trailing segment of a qualified path, so a leading dot
    // is allowed)
    const tableToken = tokenAlternatives(owner.name, { allowLeadingDot: true });
    const definitionPattern = new RegExp(
      `${tableToken}\\s+(?:AS\\s+)?(${tokenAlternatives(alias)})`,
      "gi",
    );
    const match = definitionPattern.exec(masked);
    if (!match || match[1] == null) {
      return null;
    }
    const definition: SqlRange = {
      from: match.index + match[0].length - match[1].length,
      to: match.index + match[0].length,
    };
    // Alias uses are qualifier positions (`alias.column`); bare same-named
    // identifiers elsewhere are likely columns and are left alone
    const uses = scanOccurrences(masked, alias, { followedByDot: true });
    const references = dedupeAndSort([definition, ...uses]);
    if (!containsRange(references, token)) {
      return null;
    }
    return { kind: "table-alias", name: alias, definition, references };
  }

  const selectAlias = context.selectAliases.find((a) => a.toLowerCase() === lower);
  if (selectAlias) {
    const depths = parenDepths(masked);
    const atTopLevel = (index: number) => depths[index] === 0;

    const fromMatch = topLevelMatch(masked, /\bFROM\b/gi, atTopLevel);
    const selectListEnd = fromMatch ? fromMatch.index : masked.length;
    const definitionPattern = new RegExp(`\\bAS\\s+(${tokenAlternatives(selectAlias)})`, "gi");
    let definition: SqlRange | null = null;
    let defMatch = definitionPattern.exec(masked);
    while (defMatch !== null) {
      const nameFrom = defMatch.index + defMatch[0].length - (defMatch[1]?.length ?? 0);
      if (atTopLevel(defMatch.index) && nameFrom < selectListEnd) {
        definition = { from: nameFrom, to: defMatch.index + defMatch[0].length };
        break;
      }
      defMatch = definitionPattern.exec(masked);
    }
    if (!definition) {
      return null;
    }

    // Select aliases are only referenceable from GROUP BY / ORDER BY /
    // HAVING / QUALIFY clauses of the same (top-level) query
    const regions = clauseRegions(masked, atTopLevel);
    const uses = scanOccurrences(masked, selectAlias).filter((range) =>
      regions.some((region) => range.from >= region.from && range.to <= region.to),
    );
    const references = dedupeAndSort([definition, ...uses]);
    if (!containsRange(references, token)) {
      return null;
    }
    return { kind: "select-alias", name: selectAlias, definition, references };
  }

  return null;
}

function topLevelMatch(
  text: string,
  pattern: RegExp,
  atTopLevel: (index: number) => boolean,
): RegExpExecArray | null {
  let match = pattern.exec(text);
  while (match !== null) {
    if (atTopLevel(match.index)) {
      return match;
    }
    match = pattern.exec(text);
  }
  return null;
}

const CLAUSE_START = /\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY)\b/gi;
const CLAUSE_BOUNDARY =
  /\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY|LIMIT|OFFSET|FETCH|WINDOW|UNION|INTERSECT|EXCEPT)\b/gi;

/** Top-level GROUP BY/ORDER BY/HAVING/QUALIFY clause bodies */
function clauseRegions(masked: string, atTopLevel: (index: number) => boolean): SqlRange[] {
  const regions: SqlRange[] = [];
  CLAUSE_START.lastIndex = 0;
  let match = CLAUSE_START.exec(masked);
  while (match !== null) {
    if (atTopLevel(match.index)) {
      const start = match.index + match[0].length;
      CLAUSE_BOUNDARY.lastIndex = start;
      let end = masked.length;
      let boundary = CLAUSE_BOUNDARY.exec(masked);
      while (boundary !== null) {
        if (atTopLevel(boundary.index)) {
          end = boundary.index;
          break;
        }
        boundary = CLAUSE_BOUNDARY.exec(masked);
      }
      regions.push({ from: start, to: end });
    }
    match = CLAUSE_START.exec(masked);
  }
  return regions;
}

/**
 * Resolves statement-local identifiers (CTE names, table aliases, select
 * aliases) to their definition and references. Purely local analysis — no
 * schema required. Returns null when the identifier under the cursor is not
 * confidently resolvable (never guesses).
 */
export class SqlReferenceResolver {
  private structureAnalyzer: SqlStructureAnalyzer;
  private contextAnalyzer: QueryContextAnalyzer;

  constructor(config: SqlReferenceConfig = {}) {
    const parser = config.parser ?? new NodeSqlParser();
    this.structureAnalyzer = config.structureAnalyzer ?? new SqlStructureAnalyzer(parser);
    this.contextAnalyzer = config.contextAnalyzer ?? new QueryContextAnalyzer(parser);
  }

  async resolve(state: EditorState, pos: number): Promise<SqlReferenceResult | null> {
    const token = identifierTokenAt(state, pos);
    if (!token) {
      return null;
    }
    const statement = await statementAt(this.structureAnalyzer, state, pos);
    if (!statement || token.from < statement.from || token.to > statement.to) {
      return null;
    }
    const statementText = state.sliceDoc(statement.from, statement.to);
    const context = await this.contextAnalyzer.getContext(statementText, { state });

    const relativeToken = {
      from: token.from - statement.from,
      to: token.to - statement.from,
      text: token.text,
    };
    const result = resolveInStatement(statementText, context, relativeToken);
    if (!result) {
      return null;
    }
    const shift = (range: SqlRange): SqlRange => ({
      from: range.from + statement.from,
      to: range.to + statement.from,
    });
    return {
      ...result,
      definition: shift(result.definition),
      references: result.references.map(shift),
    };
  }
}

let defaultResolver: SqlReferenceResolver | null = null;

/**
 * Finds the definition and all references of the statement-local identifier
 * (CTE name, table alias, or select alias) at `pos`.
 *
 * @example
 * ```ts
 * const result = await findReferences(view.state, view.state.selection.main.head);
 * if (result) {
 *   console.log(result.kind, result.definition, result.references);
 * }
 * ```
 */
export async function findReferences(
  state: EditorState,
  pos: number,
  config?: SqlReferenceConfig,
): Promise<SqlReferenceResult | null> {
  if (config) {
    return new SqlReferenceResolver(config).resolve(state, pos);
  }
  defaultResolver ??= new SqlReferenceResolver();
  return defaultResolver.resolve(state, pos);
}
