import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");

interface PackedFile {
  path: string;
}

/**
 * Collect every string file path referenced anywhere in the package.json
 * `exports` map (recursing through conditional-export objects like
 * `{ import: { types, default } }`).
 */
function collectExportTargets(exportsField: unknown, out: string[] = []): string[] {
  if (typeof exportsField === "string") {
    out.push(exportsField);
  } else if (exportsField && typeof exportsField === "object") {
    for (const value of Object.values(exportsField as Record<string, unknown>)) {
      collectExportTargets(value, out);
    }
  }
  return out;
}

describe("published package", () => {
  // Run the real `npm pack` so we assert against the actual tarball contents,
  // not the source tree. Regression guard for the `./data/*` exports that
  // shipped dead in 0.2.5–0.2.7 because `src/data/` was missing at publish time.
  const packed: PackedFile[] = JSON.parse(
    execSync("npm pack --dry-run --json", { cwd: repoRoot, encoding: "utf8" }),
  )[0].files;
  const packedPaths = new Set(packed.map((f) => f.path));

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  // Only assert source-committed targets (e.g. src/data/*.json). `dist/*`
  // targets are intentionally skipped: in CI `pnpm test` runs before
  // `pnpm build`, so dist does not exist yet when this test executes.
  const sourceTargets = collectExportTargets(pkg.exports)
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => p.startsWith("src/"));

  it("includes every src/ export target in the tarball", () => {
    expect(sourceTargets.length).toBeGreaterThan(0);
    for (const target of sourceTargets) {
      expect(packedPaths, `${target} is referenced by exports but missing from the npm tarball`).toContain(target);
    }
  });
});
