import { nodes, record } from "../sql/ast.js";
import { execSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");

/**
 * Collect every string file path referenced anywhere in the package.json
 * `exports` map (recursing through conditional-export objects like
 * `{ import: { types, default } }`).
 */
function collectExportTargets(exportsField: unknown, out: string[] = []): string[] {
  if (typeof exportsField === "string") {
    out.push(exportsField);
  } else if (exportsField && typeof exportsField === "object") {
    for (const value of Object.values(exportsField)) {
      collectExportTargets(value, out);
    }
  }
  return out;
}

describe("published package", () => {
  // Run the real `npm pack` so we assert against the actual tarball contents,
  // not the source tree. Regression guard for the `./data/*` exports that
  // shipped dead in 0.2.5–0.2.7 because `src/data/` was missing at publish time.
  const packed: unknown = JSON.parse(
    execSync("npm pack --dry-run --json", { cwd: repoRoot, encoding: "utf8" }),
  );
  const files = nodes(nodes(packed)[0]?.files);
  const packedPaths = new Set(files.map((file) => file.path));

  const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  // Only assert source-committed targets (e.g. src/data/*.json). `dist/*`
  // targets are intentionally skipped: in CI `pnpm test` runs before
  // `pnpm build`, so dist does not exist yet when this test executes.
  const sourceTargets = collectExportTargets(record(pkg)?.exports)
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => p.startsWith("src/"));

  it("includes every src/ export target in the tarball", () => {
    expect(sourceTargets.length).toBeGreaterThan(0);
    for (const target of sourceTargets) {
      expect(packedPaths, `${target} is referenced by exports but missing from the npm tarball`).toContain(target);
    }
  });
});


describe("built package in Node.js", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  });

  it("imports published entry points and parses unsupported DuckDB syntax without Vite", () => {
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { EditorState } from '@codemirror/state';
      import { NodeSqlParser, createSqlAnalysis, sqlExtension } from '@marimo-team/codemirror-sql';
      import { BigQueryDialect, DuckDBDialect, DremioDialect } from '@marimo-team/codemirror-sql/dialects';
      const state = EditorState.create();
      const parser = new NodeSqlParser({ getParserOptions: () => ({ database: 'DuckDB' }) });
      assert.deepEqual(await parser.parse('FROM users', { state }), { success: true, errors: [] });
      assert.equal((await parser.parse('SELECT 1', { state })).success, true);
      assert.ok(sqlExtension(createSqlAnalysis({ parser })).length > 0);
      assert.ok(BigQueryDialect.spec.keywords.includes('select'));
      assert.ok(DuckDBDialect.spec.keywords);
      assert.ok(DremioDialect.spec.keywords);
    `], { cwd: repoRoot, stdio: "pipe" });
  });
});
