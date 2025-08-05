import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { convertToCodeMirrorDiagnostic } from "../../diagnostics.js";
import { NodeSqlParser } from "../../parser.js";

describe("Error Positioning", () => {
  const createState = (content: string) => {
    return EditorState.create({
      doc: Text.of(content.split("\n")),
    });
  };

  const testSchema = {
    users: ["id", "name", "email", "active"],
    posts: ["id", "title", "user_id"],
    orders: ["id", "customer_id", "order_date", "total_amount"],
  };

  describe("column error positioning", () => {
    it("should position error under invalid column name", async () => {
      const content = "SELECT co FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'co' does not exist");

      // Test the diagnostic conversion
      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should span the column name "co"
      const line = state.doc.line(1);
      const expectedFrom = line.from + 7; // Position of "co" in "SELECT co FROM users;"
      const expectedTo = expectedFrom + 2; // Length of "co"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    it("should position error under invalid column name in complex query", async () => {
      const content = "SELECT id, invalid_col, email FROM users WHERE active = true;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'invalid_col' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should span the column name "invalid_col"
      const line = state.doc.line(1);
      const expectedFrom = line.from + 11; // Position of "invalid_col" in the query (column 12 - 1)
      const expectedTo = expectedFrom + 11; // Length of "invalid_col"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    // it("should position error under qualified column name", async () => {
    //   const content = "SELECT u.invalid_col FROM users u;";
    //   const parser = new NodeSqlParser({ schema: testSchema });

    //   const errors = await parser.validateSql(content, { state: createState(content) });

    //   expect(errors).toHaveLength(1);
    //   expect(errors[0].message).toContain("Column 'invalid_col' does not exist");

    //   const state = createState(content);
    //   const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

    //   // The error should span the column name "invalid_col"
    //   const line = state.doc.line(1);
    //   const expectedFrom = line.from + 9; // Position of "invalid_col" in "SELECT u.invalid_col FROM users u;"
    //   const expectedTo = expectedFrom + 11; // Length of "invalid_col"

    //   expect(diagnostic.from).toBe(expectedFrom);
    //   expect(diagnostic.to).toBe(expectedTo);
    // });

    it("should handle multiple column errors", async () => {
      const content = "SELECT invalid1, name, invalid2 FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(2);

      const state = createState(content);

      // First error should be for "invalid1"
      expect(errors[0].message).toContain("Column 'invalid1' does not exist");
      const firstDiagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);
      const line = state.doc.line(1);
      const firstErrorFrom = line.from + 7; // Position of "invalid1"
      const firstErrorTo = firstErrorFrom + 8; // Length of "invalid1"
      expect(firstDiagnostic.from).toBe(firstErrorFrom);
      expect(firstDiagnostic.to).toBe(firstErrorTo);

      // Second error should be for "invalid2"
      expect(errors[1].message).toContain("Column 'invalid2' does not exist");
      const secondDiagnostic = convertToCodeMirrorDiagnostic(errors[1], state.doc);
      const secondErrorFrom = line.from + 23; // Position of "invalid2"
      const secondErrorTo = secondErrorFrom + 8; // Length of "invalid2"
      expect(secondDiagnostic.from).toBe(secondErrorFrom);
      expect(secondDiagnostic.to).toBe(secondErrorTo);
    });
  });

  //   describe("table error positioning", () => {
  //     it("should position error under invalid table name", async () => {
  //       const content = "SELECT * FROM invalid_table;";
  //       const parser = new NodeSqlParser({ schema: testSchema });
  //       const errors = await parser.validateSql(content, { state: createState(content) });
  //       // There might be multiple errors, find the table error
  //       const tableError = errors.find((e) =>
  //         e.message.includes("Table 'invalid_table' does not exist"),
  //       );
  //       expect(tableError).toBeDefined();
  //       const state = createState(content);
  //       const diagnostic = convertToCodeMirrorDiagnostic(tableError as SqlParseError, state.doc);
  //       // The error should span the table name "invalid_table"
  //       const line = state.doc.line(1);
  //       const expectedFrom = line.from + 14; // Position of "invalid_table" in "SELECT * FROM invalid_table;"
  //       const expectedTo = expectedFrom + 14; // Length of "invalid_table"
  //       expect(diagnostic.from).toBe(expectedFrom);
  //       expect(diagnostic.to).toBe(expectedTo);
  //     });
  //     it("should position error under invalid table name in JOIN", async () => {
  //       const content = "SELECT u.name FROM users u JOIN invalid_table t ON u.id = t.user_id;";
  //       const parser = new NodeSqlParser({ schema: testSchema });
  //       const errors = await parser.validateSql(content, { state: createState(content) });
  //       // There might be multiple errors, find the table error
  //       const tableError = errors.find((e) =>
  //         e.message.includes("Table 'invalid_table' does not exist"),
  //       );
  //       expect(tableError).toBeDefined();
  //       const state = createState(content);
  //       const diagnostic = convertToCodeMirrorDiagnostic(tableError as SqlParseError, state.doc);
  //       // The error should span the table name "invalid_table"
  //       const line = state.doc.line(1);
  //       const expectedFrom = line.from + 32; // Position of "invalid_table" in the query
  //       const expectedTo = expectedFrom + 13; // Length of "invalid_table"
  //       expect(diagnostic.from).toBe(expectedFrom);
  //       expect(diagnostic.to).toBe(expectedTo);
  //     });
  //   });

  describe("syntax error positioning", () => {
    it("should position error at syntax error location", async () => {
      const content = "SELECT * FROM;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("unexpected token");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be at the semicolon position
      const line = state.doc.line(1);
      const expectedFrom = line.from + 13; // Position of ";" in "SELECT * FROM;"
      const expectedTo = expectedFrom + 1; // Length of ";"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    // it(
    //   "should position error at missing table name",
    //   async () => {
    //     const content = "INSERT INTO VALUES (1, 2);";
    //     const parser = new NodeSqlParser({ schema: testSchema });

    //     const errors = await parser.validateSql(content, { state: createState(content) });

    //     expect(errors).toHaveLength(1);
    //     expect(errors[0].message).toContain("unexpected token");

    //     const state = createState(content);
    //     const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

    //     // The error should be at the VALUES keyword
    //     const line = state.doc.line(1);
    //     const expectedFrom = line.from + 19; // Position of "VALUES" in "INSERT INTO VALUES (1, 2);"
    //     const expectedTo = expectedFrom + 6; // Length of "VALUES"

    //     expect(diagnostic.from).toBe(expectedFrom);
    //     expect(diagnostic.to).toBe(expectedTo);
    //   },
    // );
  });

  describe("multi-line error positioning", () => {
    it("should position error correctly in multi-line query", async () => {
      const content = `
        SELECT id,
               invalid_column,
               email
        FROM users
        WHERE active = true;
      `;
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'invalid_column' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be on line 3 (the line with invalid_column)
      expect(diagnostic.from).toBeGreaterThan(state.doc.line(2).from);
      expect(diagnostic.from).toBeLessThan(state.doc.line(3).from);
    });

    it("should handle errors in complex multi-line queries", async () => {
      const content = `
        SELECT u.id,
               u.name,
               p.invalid_column
        FROM users u
        JOIN posts p ON u.id = p.user_id
        WHERE u.active = true;
      `;
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'invalid_column' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be on line 4 (the line with p.invalid_column)
      expect(diagnostic.from).toBeGreaterThan(state.doc.line(3).from);
      expect(diagnostic.from).toBeLessThan(state.doc.line(4).from);
    });
  });

  describe("error range calculation", () => {
    it("should span the entire column name for column errors", async () => {
      const content = "SELECT very_long_column_name FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      const line = state.doc.line(1);
      const expectedFrom = line.from + 7; // Position of "very_long_column_name"
      const expectedTo = expectedFrom + 21; // Length of "very_long_column_name"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    it("should handle single character column names", async () => {
      const content = "SELECT x FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      const line = state.doc.line(1);
      const expectedFrom = line.from + 7; // Position of "x"
      const expectedTo = expectedFrom + 1; // Length of "x"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });
  });

  describe("comment handling", () => {
    it("should position error correctly when SQL follows a comment", async () => {
      const content = "-- comment\nSELECT not_exists FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'not_exists' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be on line 2 (the SQL line), not line 1 (the comment)
      expect(diagnostic.from).toBeGreaterThan(state.doc.line(1).from);
      expect(diagnostic.from).toBeGreaterThanOrEqual(state.doc.line(2).from);

      // The error should be positioned at the column name "not_exists"
      const line = state.doc.line(2);
      const expectedFrom = line.from + 7; // Position of "not_exists" in "SELECT not_exists FROM users;"
      const expectedTo = expectedFrom + 10; // Length of "not_exists"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    it("should handle multiple comments before SQL", async () => {
      const content = "-- first comment\n-- second comment\nSELECT invalid_col FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'invalid_col' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be on line 3 (the SQL line)
      expect(diagnostic.from).toBeGreaterThan(state.doc.line(2).from);
      expect(diagnostic.from).toBeGreaterThanOrEqual(state.doc.line(3).from);

      // The error should be positioned at the column name "invalid_col"
      const line = state.doc.line(3);
      const expectedFrom = line.from + 7; // Position of "invalid_col" in "SELECT invalid_col FROM users;"
      const expectedTo = expectedFrom + 11; // Length of "invalid_col"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });

    it("should handle comment after SQL", async () => {
      const content = "SELECT invalid_col FROM users; -- comment";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Column 'invalid_col' does not exist");

      const state = createState(content);
      const diagnostic = convertToCodeMirrorDiagnostic(errors[0], state.doc);

      // The error should be on line 1
      const line = state.doc.line(1);
      const expectedFrom = line.from + 7; // Position of "invalid_col" in "SELECT invalid_col FROM users; -- comment"
      const expectedTo = expectedFrom + 11; // Length of "invalid_col"

      expect(diagnostic.from).toBe(expectedFrom);
      expect(diagnostic.to).toBe(expectedTo);
    });
  });

  describe("wildcard handling", () => {
    it("should not flag * wildcard as an error", async () => {
      const content = "SELECT * FROM users;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should not have any errors for the * wildcard
      const wildcardErrors = errors.filter((error) =>
        error.message.includes("Column '*' does not exist"),
      );
      expect(wildcardErrors).toHaveLength(0);
    });

    it("should not flag qualified * wildcard as an error", async () => {
      const content = "SELECT u.* FROM users u;";
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should not have any errors for the u.* wildcard
      const wildcardErrors = errors.filter((error) =>
        error.message.includes("Column '*' does not exist"),
      );
      expect(wildcardErrors).toHaveLength(0);
    });
  });

  describe("CTE handling", () => {
    it("should not flag CTE table names as missing", async () => {
      const content = `
        WITH cte AS (
          SELECT * FROM users
        )
        SELECT * FROM cte;
      `;
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should not have any errors for the CTE table 'cte'
      const cteErrors = errors.filter((error) =>
        error.message.includes("Table 'cte' does not exist"),
      );
      expect(cteErrors).toHaveLength(0);
    });

    it("should handle multiple CTEs", async () => {
      const content = `
        WITH cte1 AS (
          SELECT id, name FROM users
        ),
        cte2 AS (
          SELECT * FROM cte1 WHERE id > 1
        )
        SELECT * FROM cte2;
      `;
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should not have any errors for the CTE tables
      const cteErrors = errors.filter(
        (error) =>
          error.message.includes("Table 'cte1' does not exist") ||
          error.message.includes("Table 'cte2' does not exist"),
      );
      expect(cteErrors).toHaveLength(0);
    });

    it("should handle qualified CTE references", async () => {
      const content = `
        WITH cte AS (
          SELECT id, name FROM users
        )
        SELECT cte.id, cte.name FROM cte;
      `;
      const parser = new NodeSqlParser({ schema: testSchema });

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should not have any errors for the CTE table itself
      const tableErrors = errors.filter((error) =>
        error.message.includes("Table 'cte' does not exist"),
      );
      expect(tableErrors).toHaveLength(0);

      // Note: Column validation within CTEs is not yet implemented
      // This would require analyzing the CTE definition to determine available columns
      const columnErrors = errors.filter(
        (error) =>
          error.message.includes("Column 'id' does not exist in table 'cte'") ||
          error.message.includes("Column 'name' does not exist in table 'cte'"),
      );
      // For now, we expect column validation errors until CTE column analysis is implemented
      expect(columnErrors.length).toBeGreaterThan(0);
    });
  });
});
