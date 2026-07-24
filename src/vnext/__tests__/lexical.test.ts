import { describe, expect, it } from "vitest";
import {
  isSqlWhitespace,
  scanSqlBlockComment,
  scanSqlDollarQuote,
  scanSqlQuoted,
  sqlIdentifierContinueLengthAt,
  sqlIdentifierStartLengthAt,
} from "../lexical.js";

describe("shared SQL lexical primitives", () => {
  it("uses UTF-16 identifier lengths without splitting valid pairs", () => {
    expect(sqlIdentifierStartLengthAt("a", 0)).toBe(1);
    expect(sqlIdentifierContinueLengthAt("1", 0)).toBe(1);
    expect(sqlIdentifierStartLengthAt("😀", 0)).toBe(2);
    expect(sqlIdentifierContinueLengthAt("\uD800", 0)).toBe(1);
    expect(sqlIdentifierStartLengthAt("1", 0)).toBe(0);
  });

  it("recognizes only the SQL whitespace set", () => {
    for (const code of [9, 10, 11, 12, 13, 32]) {
      expect(isSqlWhitespace(code)).toBe(true);
    }
    expect(isSqlWhitespace(0xa0)).toBe(false);
  });

  it("never scans a quote beyond its explicit limit", () => {
    expect(scanSqlQuoted("'abc'x", 0, 4, 39, 1, false, true, false)).toEqual({
      closed: false,
      to: 4,
    });
    expect(scanSqlQuoted("'abc'x", 0, 5, 39, 1, false, true, false)).toEqual({
      closed: true,
      to: 5,
    });
    expect(scanSqlQuoted("'a\nfar away", 0, 4, 39, 1, false, true, true)).toEqual({
      closed: false,
      to: 4,
    });
    expect(scanSqlQuoted("'\\\nfar away", 0, 4, 39, 1, true, true, true)).toEqual({
      closed: false,
      to: 4,
    });
  });

  it("never scans a block comment beyond its explicit limit", () => {
    expect(scanSqlBlockComment("/*x*/y", 0, 4, false)).toEqual({
      closed: false,
      to: 4,
    });
    expect(scanSqlBlockComment("/*x*/y", 0, 5, false)).toEqual({
      closed: true,
      to: 5,
    });
  });

  it("never accepts a dollar-quote close beyond its explicit limit", () => {
    expect(scanSqlDollarQuote("$$x$$y", 0, 4)).toEqual({
      closed: false,
      delimiterTooLong: false,
      to: 4,
    });
    expect(scanSqlDollarQuote("$$x$$y", 0, 5)).toEqual({
      closed: true,
      delimiterTooLong: false,
      to: 5,
    });
    expect(scanSqlDollarQuote("$tag$x$tag$far$tag$", 0, 10)).toEqual({
      closed: false,
      delimiterTooLong: false,
      to: 10,
    });
  });
});
