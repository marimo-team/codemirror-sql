const sqlRelationDialectRuntimes = new WeakSet<object>();

export function registerSqlRelationDialectRuntime<
  Runtime extends object,
>(runtime: Runtime): Runtime {
  sqlRelationDialectRuntimes.add(runtime);
  return runtime;
}

export function isSqlRelationDialectRuntime(
  candidate: unknown,
): boolean {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    sqlRelationDialectRuntimes.has(candidate)
  );
}
