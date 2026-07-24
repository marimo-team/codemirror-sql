import {
  createNodeSqlParserBackend,
  type NodeSqlParserBackend,
  type NodeSqlParserBackendOutcome,
  type NodeSqlParserModuleLoadOutcome,
  type NodeSqlParserModuleLoader,
} from "./node-sql-parser-backend.js";
import {
  createCompatibilityParsedAnalysis,
  createFailedParserAnalysis,
  createSqlDialectSyntaxIdentity,
  createSqlParserAuthority,
  createSqlStatementParser,
  createSqlSyntaxArtifact,
  createSqlSyntaxBackendIdentity,
  createSqlSyntaxConfigurationIdentity,
  createUnsupportedParserAnalysis,
  type SqlCompatibilityLimitation,
  type SqlParserAuthority,
  type SqlStatementParser,
  type SqlSyntaxArtifact,
  type SqlSyntaxBackendIdentity,
} from "./syntax.js";

export { MAX_NODE_SQL_PARSER_STATEMENT_LENGTH } from "./node-sql-parser-backend.js";

const TARGET_GRAMMAR_LIMITATIONS = Object.freeze([
  "partial-artifact",
] as const);
const DIALECT_COMPATIBILITY_LIMITATIONS = Object.freeze([
  "dialect-compatibility",
  "partial-artifact",
] as const);

type NodeSqlParserPolicy =
  | "dialect-compatibility"
  | "target-grammar";

interface NodeSqlParserRuntime {
  readonly authority: SqlParserAuthority;
  readonly backend: NodeSqlParserBackend;
  readonly limitations: readonly [
    SqlCompatibilityLimitation,
    ...SqlCompatibilityLimitation[],
  ];
  readonly policy: NodeSqlParserPolicy;
}

type OwnDataProperty =
  | {
    readonly kind: "missing";
  }
  | {
    readonly kind: "invalid";
  }
  | {
    readonly kind: "value";
    readonly value: unknown;
  };

class NodeSqlParserGlobalCleanupError extends Error {}
class NodeSqlParserExecutionRealmError extends Error {}

const backendPayloads = new WeakMap<SqlSyntaxArtifact, object>();

function readOwnDataProperty(
  value: object,
  key: PropertyKey,
): OwnDataProperty {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return { kind: "invalid" };
  }
  if (descriptor === undefined) {
    return { kind: "missing" };
  }
  if (!("value" in descriptor)) {
    return { kind: "invalid" };
  }
  return {
    kind: "value",
    value: descriptor.value,
  };
}

function readDataProperty(
  value: object,
  key: PropertyKey,
): OwnDataProperty {
  let candidate: object | null = value;
  for (let depth = 0; candidate !== null && depth < 16; depth += 1) {
    const property = readOwnDataProperty(candidate, key);
    if (property.kind !== "missing") {
      return property;
    }
    try {
      candidate = Object.getPrototypeOf(candidate);
    } catch {
      return { kind: "invalid" };
    }
  }
  return candidate === null
    ? { kind: "missing" }
    : { kind: "invalid" };
}

const PARSER_GLOBAL_KEYS = ["NodeSQLParser", "global"] as const;

type ParserGlobalSnapshots = readonly {
  readonly descriptor: PropertyDescriptor | undefined;
  readonly key: (typeof PARSER_GLOBAL_KEYS)[number];
}[];

function snapshotParserGlobals(target: object): ParserGlobalSnapshots {
  try {
    return PARSER_GLOBAL_KEYS.map((key) => ({
      descriptor: Object.getOwnPropertyDescriptor(target, key),
      key,
    }));
  } catch {
    throw new NodeSqlParserGlobalCleanupError();
  }
}

function restoreParserGlobals(
  target: object,
  snapshots: ParserGlobalSnapshots,
): boolean {
  let cleanupFailed = false;
  for (const snapshot of snapshots) {
    try {
      if (snapshot.descriptor === undefined) {
        if (!Reflect.deleteProperty(target, snapshot.key)) {
          cleanupFailed = true;
        }
      } else {
        Object.defineProperty(
          target,
          snapshot.key,
          snapshot.descriptor,
        );
      }
    } catch {
      cleanupFailed = true;
    }
  }
  return !cleanupFailed;
}

function createSynchronousModuleLoader(target: object) {
  let poisoned = false;
  return (loadModule: () => unknown): unknown => {
    if (poisoned) {
      throw new NodeSqlParserGlobalCleanupError();
    }
    let snapshots: ParserGlobalSnapshots;
    try {
      snapshots = snapshotParserGlobals(target);
    } catch {
      poisoned = true;
      throw new NodeSqlParserGlobalCleanupError();
    }
    const outcome:
      | { readonly kind: "failed"; readonly error: unknown }
      | { readonly kind: "loaded"; readonly value: unknown } = (() => {
        try {
          return {
            kind: "loaded",
            value: loadModule(),
          };
        } catch (error: unknown) {
          return {
            error,
            kind: "failed",
          };
        }
      })();
    if (!restoreParserGlobals(target, snapshots)) {
      poisoned = true;
      throw new NodeSqlParserGlobalCleanupError();
    }
    if (outcome.kind === "failed") {
      throw outcome.error;
    }
    return outcome.value;
  };
}

const loadNodeModuleSynchronously =
  createSynchronousModuleLoader(globalThis);

function rejectUnsupportedExecutionRealm(): void {
  const windowAlias = readDataProperty(globalThis, "window");
  const selfAlias = readDataProperty(globalThis, "self");
  const globalAlias = readDataProperty(globalThis, "global");
  if (
    windowAlias.kind === "invalid" ||
    (windowAlias.kind === "value" &&
      windowAlias.value !== undefined) ||
    selfAlias.kind === "invalid" ||
    (selfAlias.kind === "value" &&
      selfAlias.value !== undefined) ||
    globalAlias.kind === "invalid" ||
    globalAlias.kind !== "value" ||
    globalAlias.value !== globalThis
  ) {
    throw new NodeSqlParserExecutionRealmError();
  }
}

async function loadNodeSqlParserBuild(
  specifier: string,
): Promise<NodeSqlParserModuleLoadOutcome> {
  try {
    rejectUnsupportedExecutionRealm();
    const { createRequire } = await import("node:module");
    rejectUnsupportedExecutionRealm();
    const require = createRequire(import.meta.url);
    return {
      kind: "loaded",
      moduleValue: loadNodeModuleSynchronously(
        () => require(specifier),
      ),
    };
  } catch (error: unknown) {
    if (
      error instanceof NodeSqlParserGlobalCleanupError ||
      error instanceof NodeSqlParserExecutionRealmError
    ) {
      return {
        code: "backend",
        kind: "failed",
        retryable: false,
      };
    }
    return {
      code: "module-load",
      kind: "failed",
      retryable: true,
    };
  }
}

function importPostgresqlBuild(): Promise<NodeSqlParserModuleLoadOutcome> {
  return loadNodeSqlParserBuild(
    "node-sql-parser/build/postgresql.js",
  );
}

function importBigQueryBuild(): Promise<NodeSqlParserModuleLoadOutcome> {
  return loadNodeSqlParserBuild(
    "node-sql-parser/build/bigquery.js",
  );
}

function backendFailure(
  authority: SqlParserAuthority,
  statementText: string,
  message: string,
  retryable: boolean,
) {
  return createFailedParserAnalysis(
    "backend-failure",
    message,
    retryable,
    statementText,
    authority,
  );
}

function malformedOutput(
  authority: SqlParserAuthority,
  statementText: string,
) {
  return createFailedParserAnalysis(
    "malformed-output",
    "node-sql-parser returned malformed output",
    false,
    statementText,
    authority,
  );
}

function materializeBackendOutcome(
  runtime: NodeSqlParserRuntime,
  statementText: string,
  outcome: NodeSqlParserBackendOutcome,
) {
  switch (outcome.kind) {
    case "failed":
      if (outcome.code === "malformed-output") {
        return malformedOutput(runtime.authority, statementText);
      }
      return backendFailure(
          runtime.authority,
          statementText,
          outcome.code === "module-load"
            ? "node-sql-parser failed to load"
            : "node-sql-parser backend failed",
          outcome.retryable,
        );
    case "parsed": {
      const artifact = createSqlSyntaxArtifact(
        outcome.statementKind,
        statementText,
        runtime.authority,
      );
      backendPayloads.set(artifact, outcome.root);
      return createCompatibilityParsedAnalysis(
        artifact,
        runtime.limitations,
      );
    }
    case "syntax-rejected":
      return createUnsupportedParserAnalysis(
        runtime.policy === "dialect-compatibility"
          ? "compatibility-rejected"
          : "uncovered-construct",
        statementText,
        runtime.authority,
      );
    case "unsupported":
      return createUnsupportedParserAnalysis(
        outcome.reason === "resource-limit"
          ? "resource-limit"
          : "uncovered-construct",
        statementText,
        runtime.authority,
      );
  }
}

function createAdapter(runtime: NodeSqlParserRuntime): SqlStatementParser {
  return createSqlStatementParser(
    runtime.authority,
    async (request) => {
      const { signal, text } = request;
      const outcome = await runtime.backend.parse(
        text,
        () => signal.throwIfAborted(),
      );
      return materializeBackendOutcome(runtime, text, outcome);
    },
  );
}

function createRuntime(
  backendIdentity: SqlSyntaxBackendIdentity,
  backend: NodeSqlParserBackend,
  policy: NodeSqlParserPolicy,
): NodeSqlParserRuntime {
  const authority = createSqlParserAuthority(
    backendIdentity,
    createSqlSyntaxConfigurationIdentity(),
    createSqlDialectSyntaxIdentity(),
  );
  return Object.freeze({
    authority,
    backend,
    limitations:
      policy === "dialect-compatibility"
        ? DIALECT_COMPATIBILITY_LIMITATIONS
        : TARGET_GRAMMAR_LIMITATIONS,
    policy,
  });
}

const postgresqlBackendIdentity = createSqlSyntaxBackendIdentity();
const bigQueryBackendIdentity = createSqlSyntaxBackendIdentity();
const postgresqlBackend = createNodeSqlParserBackend(
  importPostgresqlBuild,
);
const bigQueryBackend = createNodeSqlParserBackend(importBigQueryBuild);

const postgresqlParser = createAdapter(
  createRuntime(
    postgresqlBackendIdentity,
    postgresqlBackend,
    "target-grammar",
  ),
);
const bigQueryParser = createAdapter(
  createRuntime(
    bigQueryBackendIdentity,
    bigQueryBackend,
    "target-grammar",
  ),
);
const duckDbParser = createAdapter(
  createRuntime(
    postgresqlBackendIdentity,
    postgresqlBackend,
    "dialect-compatibility",
  ),
);

function adaptModuleLoaderForTesting(
  loadModule: () => Promise<unknown>,
): NodeSqlParserModuleLoader {
  return async () => {
    try {
      return {
        kind: "loaded",
        moduleValue: await loadModule(),
      };
    } catch (error: unknown) {
      if (
        error instanceof NodeSqlParserGlobalCleanupError ||
        error instanceof NodeSqlParserExecutionRealmError
      ) {
        return {
          code: "backend",
          kind: "failed",
          retryable: false,
        };
      }
      return {
        code: "module-load",
        kind: "failed",
        retryable: true,
      };
    }
  };
}

export function getPostgresqlNodeSqlStatementParser(): SqlStatementParser {
  return postgresqlParser;
}

export function getBigQueryNodeSqlStatementParser(): SqlStatementParser {
  return bigQueryParser;
}

export function getDuckDbCompatibilityNodeSqlStatementParser(): SqlStatementParser {
  return duckDbParser;
}

export const exportedForTesting = Object.freeze({
  createParser(
    policy: NodeSqlParserPolicy,
    loadModule: () => Promise<unknown>,
  ): SqlStatementParser {
    const backendIdentity = createSqlSyntaxBackendIdentity();
    return createAdapter(
      createRuntime(
        backendIdentity,
        createNodeSqlParserBackend(
          adaptModuleLoaderForTesting(loadModule),
        ),
        policy,
      ),
    );
  },
  hasBackendPayload(artifact: SqlSyntaxArtifact): boolean {
    return backendPayloads.has(artifact);
  },
  createSynchronousModuleLoader,
});
