import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";

/**
 * Extracts the names of all CTEs declared in WITH clauses in the document
 */
function extractCteNames(doc: string): Set<string> {
  const cteNames = new Set<string>();

  // Start of a WITH clause (optionally recursive)
  const withPattern = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
  // CTE name with an optional column list, followed by AS (
  const ctePattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\)\s*)?\bAS\s*\(/i;

  let withMatch = withPattern.exec(doc);
  while (withMatch !== null) {
    let pos = withMatch.index + withMatch[0].length;

    for (;;) {
      const cteMatch = ctePattern.exec(doc.slice(pos));
      const cteName = cteMatch?.[1];
      if (!cteName) {
        break;
      }
      cteNames.add(cteName);

      // Skip past the CTE body, tracking nested parentheses
      let i = pos + cteMatch[0].length;
      let depth = 1;
      while (i < doc.length && depth > 0) {
        if (doc[i] === "(") depth++;
        else if (doc[i] === ")") depth--;
        i++;
      }

      // A comma introduces the next CTE in the same WITH clause
      const separator = /^\s*,\s*/.exec(doc.slice(i));
      if (!separator) {
        break;
      }
      pos = i + separator[0].length;
    }

    withMatch = withPattern.exec(doc);
  }

  return cteNames;
}

/**
 * A completion source for Common Table Expressions (CTEs) in SQL
 *
 * This function provides autocomplete suggestions for CTE references based on
 * WITH clauses found in the current SQL document.
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
export const cteCompletionSource: CompletionSource = (context: CompletionContext) => {
  const doc = context.state.doc.toString();
  const cteNames = extractCteNames(doc);

  // If no CTEs found, return null (no completions)
  if (cteNames.size === 0) {
    return null;
  }

  // Get the word being typed
  const word = context.matchBefore(/\w*/);
  if (!word) {
    return null;
  }

  // If no word is being typed and not in explicit mode, don't show completions
  if (word.from === word.to && !context.explicit) {
    return null;
  }

  // Create completion objects for each CTE
  const completions: Completion[] = Array.from(cteNames).map((cteName) => ({
    label: cteName,
    type: "variable", // CTEs are like temporary tables/variables
    info: `Common Table Expression: ${cteName}`,
    boost: 10, // Give CTEs higher priority than regular completions
  }));

  return {
    from: word.from,
    options: completions,
  };
};
