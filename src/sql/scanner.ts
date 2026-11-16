export interface SqlToken {
  kind: "comment" | "literal" | "identifier" | "symbol" | "word";
  from: number;
  to: number;
  text: string;
}

/** Offsets always refer to the original SQL, including incomplete tokens. */
export function scanSql(sql: string, options: { backslashEscapes?: boolean } = {}): SqlToken[] {
  const tokens: SqlToken[] = [];
  let pos = 0;
  while (pos < sql.length) {
    const from = pos;
    const char = sql[pos] ?? "";
    if (/\s/.test(char)) {
      pos++;
      continue;
    }
    let kind: SqlToken["kind"] = "symbol";
    if (sql.startsWith("--", pos)) {
      kind = "comment";
      while (pos < sql.length && sql[pos] !== "\n" && sql[pos] !== "\r") pos++;
    } else if (sql.startsWith("/*", pos)) {
      kind = "comment";
      pos += 2;
      let depth = 1;
      while (pos < sql.length && depth > 0) {
        if (sql.startsWith("/*", pos)) { depth++; pos += 2; }
        else if (sql.startsWith("*/", pos)) { depth--; pos += 2; }
        else pos++;
      }
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
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
    } else if (char === "$" && /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(pos))) {
      kind = "literal";
      const delimiter = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(pos))?.[0] ?? "$$";
      const end = sql.indexOf(delimiter, pos + delimiter.length);
      pos = end < 0 ? sql.length : end + delimiter.length;
    } else if (/[\w$]/.test(char)) {
      kind = "word";
      while (pos < sql.length && /[\w$]/.test(sql[pos] ?? "")) pos++;
    } else {
      pos++;
    }
    tokens.push({ kind, from, to: pos, text: sql.slice(from, pos) });
  }
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

export function stripSqlComments(sql: string): string {
  let result = "";
  let from = 0;
  for (const token of scanSql(sql)) {
    if (token.kind !== "comment") continue;
    result += sql.slice(from, token.from);
    if (/\S$/.test(result) && /^\S/.test(sql.slice(token.to))) result += " ";
    from = token.to;
  }
  return result + sql.slice(from);
}
