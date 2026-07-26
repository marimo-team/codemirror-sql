import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");

interface PackedFile {
  path: string;
}

interface PackedManifest {
  files: PackedFile[];
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
  const packOutput: PackedManifest | PackedManifest[] = JSON.parse(
    execSync("pnpm pack --dry-run --json", {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const manifest = Array.isArray(packOutput) ? packOutput[0] : packOutput;
  if (!manifest) {
    throw new Error("pnpm pack returned no package manifest");
  }
  const packed = manifest.files;
  const packedPaths = new Set(packed.map((f) => f.path));

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  it("publishes package.json and declares a dist-only export map", () => {
    expect(packedPaths).toContain("package.json");
    expect(pkg.files).toEqual(["dist"]);

    const exportTargets = collectExportTargets(pkg.exports)
      .map((path) => path.replace(/^\.\//, ""))
      .filter((path) => path !== "package.json");

    expect(exportTargets.length).toBeGreaterThan(0);
    for (const target of exportTargets) {
      expect(target.startsWith("dist/"), `${target} must live under dist/`).toBe(
        true,
      );
    }
  });
});
