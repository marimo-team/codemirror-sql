export interface SqlToken {
  kind: "comment" | "literal" | "identifier" | "symbol" | "word";
  from: number;
  to: number;
  text: string;
}

interface SqlScanOptions {
  backslashEscapes?: boolean;
  bracketIdentifiers?: boolean;
}

type ProtectedTokenKind = "comment" | "literal" | "identifier";

function visitProtectedTokens(
  sql: string,
  options: SqlScanOptions,
  visit: (kind: ProtectedTokenKind, from: number, to: number) => void,
): void {
  let pos = 0;
  let previousTokenEnd = 0;
  while (pos < sql.length) {
    const from = pos;
    const char = sql[pos];
    let kind: ProtectedTokenKind;
    if (char === "-" && sql[pos + 1] === "-") {
      kind = "comment";
      while (pos < sql.length && sql[pos] !== "\n" && sql[pos] !== "\r") pos++;
    } else if (char === "/" && sql[pos + 1] === "*") {
      kind = "comment";
      pos += 2;
      let depth = 1;
      while (pos < sql.length && depth > 0) {
        if (sql[pos] === "/" && sql[pos + 1] === "*") { depth++; pos += 2; }
        else if (sql[pos] === "*" && sql[pos + 1] === "/") { depth--; pos += 2; }
        else pos++;
      }
    } else if (char === "'" || char === '"' || char === "`" || (char === "[" && options.bracketIdentifiers !== false)) {
      kind = char === "'" ? "literal" : "identifier";
      const close = char === "[" ? "]" : char;
      pos++;
      while (pos < sql.length) {
        if (options.backslashEscapes && char !== "[" && sql[pos] === "\\") {
          pos = Math.min(sql.length, pos + 2);
          continue;
        }
        if (sql[pos] === close) {
          pos++;
          if (sql[pos] !== close) break;
        }
        pos++;
      }
    } else if (char === "$" && (pos === previousTokenEnd || !/[\w$]/.test(sql[pos - 1] ?? ""))) {
      const delimiter = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(pos))?.[0];
      if (!delimiter) {
        pos++;
        continue;
      }
      kind = "literal";
      const end = sql.indexOf(delimiter, pos + delimiter.length);
      pos = end < 0 ? sql.length : end + delimiter.length;
    } else {
      pos++;
      continue;
    }
    previousTokenEnd = pos;
    visit(kind, from, pos);
  }
}

/** Offsets always refer to the original SQL, including incomplete tokens. */
export function scanSql(sql: string, options: SqlScanOptions = {}): SqlToken[] {
  const tokens: SqlToken[] = [];
  const unquoted = /[\w$]+|[^\s]/g;
  const scanUnquoted = (from: number, to: number) => {
    if (from === to) return;
    const gap = sql.slice(from, to);
    unquoted.lastIndex = 0;
    let match = unquoted.exec(gap);
    while (match) {
      const text = match[0];
      tokens.push({
        kind: /^[\w$]/.test(text) ? "word" : "symbol",
        from: from + match.index,
        to: from + match.index + text.length,
        text,
      });
      match = unquoted.exec(gap);
    }
  };
  let from = 0;
  visitProtectedTokens(sql, options, (kind, start, end) => {
    scanUnquoted(from, start);
    tokens.push({ kind, from: start, to: end, text: sql.slice(start, end) });
    from = end;
  });
  scanUnquoted(from, sql.length);
  return tokens;
}

export function maskSql(sql: string, kinds: readonly SqlToken["kind"][]): string {
  const chars = sql.split("");
  for (const token of scanSql(sql)) {
    if (!kinds.includes(token.kind)) continue;
    for (let pos = token.from; pos < token.to; pos++) {
      if (chars[pos] !== "\n" && chars[pos] !== "\r") chars[pos] = " ";
    }
  }
  return chars.join("");
}

export function maskLiteralsAndComments(sql: string): string {
  return maskSql(sql, ["comment", "literal"]);
}

function isWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));
}

export function stripSqlComments(sql: string, options: { bracketIdentifiers?: boolean } = {}): string {
  let result = "";
  let from = 0;
  visitProtectedTokens(sql, options, (kind, start, end) => {
    if (kind !== "comment") return;
    const needsSpace = start > from && end < sql.length &&
      !isWhitespace(sql.charCodeAt(start - 1)) && !isWhitespace(sql.charCodeAt(end));
    result += sql.slice(from, start) + (needsSpace ? " " : "");
    from = end;
  });
  return result + sql.slice(from);
}
