import { describe, expect, it } from "vitest";
import {
  BoundedSqlLexer,
  MAX_BOUNDED_SQL_LEXEMES,
  type BoundedSqlLexeme,
} from "../bounded-sql-lexer.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  type SqlLexicalProfile,
} from "../lexical.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  type SqlSourceSnapshot,
} from "../source.js";

function lex(
  source: SqlSourceSnapshot,
  profile: SqlLexicalProfile = POSTGRESQL_SQL_LEXICAL_PROFILE,
): {
  readonly lexemes: readonly BoundedSqlLexeme[];
  readonly resource: BoundedSqlLexer["resource"];
} {
  const lexer = new BoundedSqlLexer(
    source,
    0,
    source.analysisText.length,
    profile,
  );
  const lexemes: BoundedSqlLexeme[] = [];
  while (true) {
    const lexeme = lexer.next();
    if (!lexeme) {
      return { lexemes, resource: lexer.resource };
    }
    lexemes.push(lexeme);
  }
}

describe("bounded SQL lexer", () => {
  it("streams words, punctuation, strings, comments, and UTF-16 ranges", () => {
    const text = "Se😀lect . 'x' -- note\n/* nested /* x */ */ end";
    expect(lex(createIdentitySqlSource(text))).toEqual({
      lexemes: [
        { closed: true, from: 0, kind: "word", to: 8 },
        { closed: true, from: 9, kind: "punctuation", to: 10 },
        { closed: true, from: 11, kind: "string", to: 14 },
        { closed: true, from: 15, kind: "line-comment", to: 22 },
        { closed: true, from: 23, kind: "comment", to: 43 },
        { closed: true, from: 44, kind: "word", to: 47 },
      ],
      resource: null,
    });
  });

  it("keeps BigQuery backticks, raw triples, and hash comments atomic", () => {
    const text = "`a.b` R'''raw\\value''' # comment";
    expect(
      lex(
        createIdentitySqlSource(text),
        BIGQUERY_SQL_LEXICAL_PROFILE,
      ),
    ).toEqual({
      lexemes: [
        {
          closed: true,
          from: 0,
          kind: "quoted-identifier",
          to: 5,
        },
        { closed: true, from: 6, kind: "word", to: 7 },
        { closed: true, from: 7, kind: "string", to: 22 },
        {
          closed: true,
          from: 23,
          kind: "line-comment",
          to: 32,
        },
      ],
      resource: null,
    });
  });

  it("emits embedded regions as barriers and finds exact boundaries", () => {
    const source = createMaskedSqlSource("a {value} b", [
      { from: 2, language: "python", to: 9 },
    ]);
    expect(lex(source).lexemes).toEqual([
      { closed: true, from: 0, kind: "word", to: 1 },
      { closed: true, from: 2, kind: "barrier", to: 9 },
      { closed: true, from: 10, kind: "word", to: 11 },
    ]);
  });

  it("pushes back one token without spending the budget twice", () => {
    const source = createIdentitySqlSource("one two");
    const lexer = new BoundedSqlLexer(
      source,
      0,
      source.analysisText.length,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    const first = lexer.next();
    expect(first).not.toBeNull();
    if (!first) {
      throw new Error("Expected first lexeme");
    }
    lexer.pushBack(first);
    expect(lexer.next()).toBe(first);
    expect(lexer.next()).toEqual({
      closed: true,
      from: 4,
      kind: "word",
      to: 7,
    });
    expect(lexer.next()).toBeNull();
    expect(lexer.resource).toBeNull();
    expect(lexer.resourceAt).toBeNull();
  });

  it("fails closed immediately after the shared lexeme budget", () => {
    const acceptedWords = Array.from(
      { length: MAX_BOUNDED_SQL_LEXEMES },
      () => "x",
    ).join(" ");
    const accepted = lex(createIdentitySqlSource(acceptedWords));
    expect(accepted.lexemes).toHaveLength(MAX_BOUNDED_SQL_LEXEMES);
    expect(accepted.resource).toBeNull();

    const words = Array.from(
      { length: MAX_BOUNDED_SQL_LEXEMES + 1 },
      () => "x",
    ).join(" ");
    const result = lex(createIdentitySqlSource(words));
    expect(result.lexemes).toHaveLength(MAX_BOUNDED_SQL_LEXEMES);
    expect(result.resource).toBe("lexical-token");
    const source = createIdentitySqlSource(words);
    const lexer = new BoundedSqlLexer(
      source,
      0,
      source.analysisText.length,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    while (lexer.next()) {
      // Consume the bounded prefix.
    }
    expect(lexer.resourceAt).toBe(
      words.lastIndexOf("x"),
    );

    const prefixed = `  ${words}`;
    const prefixedSource = createIdentitySqlSource(prefixed);
    const prefixedLexer = new BoundedSqlLexer(
      prefixedSource,
      2,
      prefixed.length,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    while (prefixedLexer.next()) {
      // Consume the bounded prefix.
    }
    expect(prefixedLexer.resourceAt).toBe(
      prefixed.lastIndexOf("x"),
    );
  });

  it("reports oversized dollar-quote delimiters without emitting a token", () => {
    const source = createIdentitySqlSource(
      `$${"a".repeat(257)}$unterminated`,
    );
    expect(lex(source)).toEqual({
      lexemes: [],
      resource: "dollar-quote-delimiter",
    });
    const lexer = new BoundedSqlLexer(
      source,
      0,
      source.analysisText.length,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(lexer.next()).toBeNull();
    expect(lexer.resourceAt).toBe(0);
  });
});
