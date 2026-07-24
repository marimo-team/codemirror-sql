import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const forbiddenModifier =
  /\b(?:describe|it|test)(?:\.[A-Za-z_$][\w$]*)*\.(?:only|skip|skipIf|todo|runIf)\s*\(/g;
const expectedFailure =
  /\b(?:it|test)(?:\.[A-Za-z_$][\w$]*)*\.fails\s*\(\s*["'`]\[known-failure: ([^\]]+)\]/g;
const anyExpectedFailure =
  /\b(?:it|test)(?:\.[A-Za-z_$][\w$]*)*\.fails\s*\(/g;
const violations = [];
const knownFailures = JSON.parse(readFileSync("test/known-failures.json", "utf8"));
const usedKnownFailures = new Set();

const bypassFixtures = [
  "describe.concurrent.skip('suite', () => {})",
  "test.skipIf(true)('case', () => {})",
  "it.runIf(false)('case', () => {})",
];
for (const fixture of bypassFixtures) {
  if (!forbiddenModifier.test(fixture)) {
    throw new Error(`Integrity scanner failed its bypass fixture: ${fixture}`);
  }
  forbiddenModifier.lastIndex = 0;
}

const expectedFailureFixtures = [
  "it.fails('[known-failure: direct] case', () => {})",
  "it.concurrent.fails('[known-failure: chained] case', () => {})",
];
for (const fixture of expectedFailureFixtures) {
  if (!expectedFailure.test(fixture) || !anyExpectedFailure.test(fixture)) {
    throw new Error(`Integrity scanner failed its expected-failure fixture: ${fixture}`);
  }
  expectedFailure.lastIndex = 0;
  anyExpectedFailure.lastIndex = 0;
}

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkDirectory(path);
      continue;
    }
    if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      continue;
    }

    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(forbiddenModifier)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path}:${line}: ${match[0]}`);
    }

    for (const match of source.matchAll(expectedFailure)) {
      const id = match[1];
      const entry = knownFailures[id];
      if (!entry) {
        violations.push(`${path}: unregistered known failure '${id}'`);
        continue;
      }
      if (
        typeof entry.owner !== "string" ||
        typeof entry.expires !== "string" ||
        typeof entry.trackingIssue !== "string"
      ) {
        violations.push(`${path}: incomplete governance for known failure '${id}'`);
        continue;
      }
      if (entry.expires < new Date().toISOString().slice(0, 10)) {
        violations.push(`${path}: known failure '${id}' expired on ${entry.expires}`);
      }
      usedKnownFailures.add(id);
    }

    const expectedFailureCount = [...source.matchAll(anyExpectedFailure)].length;
    const registeredFailureCount = [...source.matchAll(expectedFailure)].length;
    if (expectedFailureCount !== registeredFailureCount) {
      violations.push(`${path}: every expected failure must use a registered ID`);
    }
  }
}

checkDirectory("src");
checkDirectory("test");

for (const id of Object.keys(knownFailures)) {
  if (!usedKnownFailures.has(id)) {
    violations.push(`test/known-failures.json: unused known failure '${id}'`);
  }
}

if (violations.length > 0) {
  console.error("Test integrity violations:");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exitCode = 1;
}
