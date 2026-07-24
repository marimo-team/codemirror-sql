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
  MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH,
  type SqlCompatibilityLimitation,
  type SqlParserAuthority,
  type SqlStatementKind,
  type SqlStatementParser,
  type SqlSyntaxArtifact,
  type SqlSyntaxBackendIdentity,
} from "./syntax.js";

export const MAX_NODE_SQL_PARSER_STATEMENT_LENGTH = 16 * 1024;

const MAX_BACKEND_TYPE_LENGTH = 128;
const NODE_SQL_PARSER_OPTIONS = Object.freeze({
  parseOptions: Object.freeze({
    includeLocations: true,
  }),
  trimQuery: false,
});
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

interface NodeSqlParserBackend {
  readonly astify: (statementText: string) => unknown;
}

type NodeSqlParserBackendLoader = () => Promise<NodeSqlParserBackend>;
type NodeSqlParserModuleLoader = () => Promise<unknown>;

interface NodeSqlParserRuntime {
  readonly authority: SqlParserAuthority;
  readonly limitations: readonly [
    SqlCompatibilityLimitation,
    ...SqlCompatibilityLimitation[],
  ];
  readonly loadBackend: NodeSqlParserBackendLoader;
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

type DecodedRoot =
  | {
    readonly kind: "malformed";
  }
  | {
    readonly kind: "root";
    readonly root: object;
    readonly statementKind: SqlStatementKind;
  }
  | {
    readonly kind: "unsupported";
  };

type DecodedParserError =
  | "backend-failure"
  | "malformed-output"
  | "syntax-rejection";

class NodeSqlParserModuleShapeError extends Error {}
class NodeSqlParserInitializationError extends Error {}
class NodeSqlParserGlobalCleanupError extends Error {}
class NodeSqlParserExecutionRealmError extends Error {}

const backendPayloads = new WeakMap<SqlSyntaxArtifact, object>();

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function isRecordObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

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

function readDataMethod(
  value: object,
  key: PropertyKey,
): ((...arguments_: unknown[]) => unknown) | null {
  let candidate: object | null = value;
  for (let depth = 0; candidate !== null && depth < 16; depth += 1) {
    const property = readOwnDataProperty(candidate, key);
    if (property.kind === "invalid") {
      return null;
    }
    if (property.kind === "value") {
      if (typeof property.value !== "function") {
        return null;
      }
      const method = property.value;
      return (...arguments_: unknown[]) =>
        Reflect.apply(method, value, arguments_);
    }
    try {
      candidate = Object.getPrototypeOf(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

function moduleCandidates(moduleValue: unknown): readonly unknown[] {
  if (!isObjectLike(moduleValue)) {
    return [moduleValue];
  }
  const candidates: unknown[] = [moduleValue];
  for (const key of ["default", "module.exports"] as const) {
    const property = readOwnDataProperty(moduleValue, key);
    if (property.kind === "value") {
      candidates.push(property.value);
    }
  }
  return candidates;
}

function findParserConstructor(moduleValue: unknown): unknown {
  for (const candidate of moduleCandidates(moduleValue)) {
    if (typeof candidate === "function") {
      return candidate;
    }
    if (!isObjectLike(candidate)) {
      continue;
    }
    const parser = readOwnDataProperty(candidate, "Parser");
    if (parser.kind === "value" && typeof parser.value === "function") {
      return parser.value;
    }
  }
  return null;
}

function decodeBackendModule(moduleValue: unknown): NodeSqlParserBackend {
  const Parser = findParserConstructor(moduleValue);
  if (typeof Parser !== "function") {
    throw new NodeSqlParserModuleShapeError();
  }
  let parser: object;
  try {
    parser = Reflect.construct(Parser, []);
  } catch {
    throw new NodeSqlParserInitializationError();
  }
  const astify = readDataMethod(parser, "astify");
  if (astify === null) {
    throw new NodeSqlParserModuleShapeError();
  }
  return Object.freeze({
    astify(statementText: string): unknown {
      return astify(statementText, NODE_SQL_PARSER_OPTIONS);
    },
  });
}

function createRetryingBackendLoader(
  loadModule: NodeSqlParserModuleLoader,
): NodeSqlParserBackendLoader {
  let pending: Promise<NodeSqlParserBackend> | undefined;
  return async () => {
    if (pending === undefined) {
      const current = Promise.resolve()
        .then(loadModule)
        .then(decodeBackendModule);
      pending = current;
      try {
        return await current;
      } catch (error: unknown) {
        if (
          !(error instanceof NodeSqlParserModuleShapeError) &&
          !(error instanceof NodeSqlParserInitializationError) &&
          !(error instanceof NodeSqlParserGlobalCleanupError) &&
          !(error instanceof NodeSqlParserExecutionRealmError)
        ) {
          pending = undefined;
        }
        throw error;
      }
    }
    return await pending;
  };
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
): Promise<unknown> {
  rejectUnsupportedExecutionRealm();
  const { createRequire } = await import("node:module");
  rejectUnsupportedExecutionRealm();
  const require = createRequire(import.meta.url);
  return loadNodeModuleSynchronously(
    () => require(specifier),
  );
}

function importPostgresqlBuild(): Promise<unknown> {
  return loadNodeSqlParserBuild(
    "node-sql-parser/build/postgresql.js",
  );
}

function importBigQueryBuild(): Promise<unknown> {
  return loadNodeSqlParserBuild(
    "node-sql-parser/build/bigquery.js",
  );
}

function mapStatementKind(backendType: string): SqlStatementKind {
  switch (backendType.toLowerCase()) {
    case "select":
    case "union":
      return "query";
    case "insert":
    case "replace":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "create":
      return "create";
    case "alter":
      return "alter";
    case "drop":
      return "drop";
    case "merge":
      return "merge";
    case "transaction":
      return "transaction";
    default:
      return "other";
  }
}

function decodeRoot(value: unknown): DecodedRoot {
  let root = value;
  let rootIsArray: boolean;
  try {
    rootIsArray = Array.isArray(root);
  } catch {
    return { kind: "malformed" };
  }
  if (rootIsArray && isRecordObject(root)) {
    const length = readOwnDataProperty(root, "length");
    if (length.kind !== "value") {
      return { kind: "malformed" };
    }
    if (length.value !== 1) {
      return { kind: "unsupported" };
    }
    const first = readOwnDataProperty(root, 0);
    if (first.kind !== "value") {
      return { kind: "malformed" };
    }
    root = first.value;
  }
  if (!isRecordObject(root)) {
    return { kind: "malformed" };
  }
  const type = readOwnDataProperty(root, "type");
  if (
    type.kind !== "value" ||
    typeof type.value !== "string" ||
    type.value.length === 0 ||
    type.value.length > MAX_BACKEND_TYPE_LENGTH ||
    type.value.trim() !== type.value
  ) {
    return { kind: "malformed" };
  }
  return {
    kind: "root",
    root,
    statementKind: mapStatementKind(type.value),
  };
}

function decodeSafeOffset(
  value: unknown,
  statementLength: number,
): number | null {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= statementLength
  ) {
    return value;
  }
  return null;
}

function decodeParserError(
  error: unknown,
  statementLength: number,
): DecodedParserError {
  if (!isObjectLike(error)) {
    return "backend-failure";
  }
  const name = readOwnDataProperty(error, "name");
  if (
    name.kind !== "value" ||
    name.value !== "SyntaxError"
  ) {
    return "backend-failure";
  }
  const message = readOwnDataProperty(error, "message");
  const location = readOwnDataProperty(error, "location");
  if (
    message.kind !== "value" ||
    typeof message.value !== "string" ||
    message.value.trim().length === 0 ||
    message.value.length > MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH ||
    location.kind !== "value" ||
    !isRecordObject(location.value)
  ) {
    return "malformed-output";
  }
  const start = readOwnDataProperty(location.value, "start");
  const end = readOwnDataProperty(location.value, "end");
  if (
    start.kind !== "value" ||
    end.kind !== "value" ||
    !isRecordObject(start.value) ||
    !isRecordObject(end.value)
  ) {
    return "malformed-output";
  }
  const startOffset = readOwnDataProperty(start.value, "offset");
  const endOffset = readOwnDataProperty(end.value, "offset");
  if (
    startOffset.kind !== "value" ||
    endOffset.kind !== "value"
  ) {
    return "malformed-output";
  }
  const from = decodeSafeOffset(startOffset.value, statementLength);
  const to = decodeSafeOffset(endOffset.value, statementLength);
  if (from === null || to === null || from > to) {
    return "malformed-output";
  }
  return "syntax-rejection";
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

function createAdapter(runtime: NodeSqlParserRuntime): SqlStatementParser {
  return createSqlStatementParser(
    runtime.authority,
    async (request) => {
      const { signal, text } = request;
      if (text.length > MAX_NODE_SQL_PARSER_STATEMENT_LENGTH) {
        return createUnsupportedParserAnalysis(
          "resource-limit",
          text,
          runtime.authority,
        );
      }

      signal.throwIfAborted();
      let backend: NodeSqlParserBackend;
      try {
        backend = await runtime.loadBackend();
      } catch (error: unknown) {
        signal.throwIfAborted();
        if (error instanceof NodeSqlParserModuleShapeError) {
          return malformedOutput(runtime.authority, text);
        }
        if (
          error instanceof NodeSqlParserInitializationError ||
          error instanceof NodeSqlParserGlobalCleanupError ||
          error instanceof NodeSqlParserExecutionRealmError
        ) {
          return backendFailure(
            runtime.authority,
            text,
            "node-sql-parser backend failed",
            false,
          );
        }
        return backendFailure(
          runtime.authority,
          text,
          "node-sql-parser failed to load",
          true,
        );
      }
      signal.throwIfAborted();

      let output: unknown;
      try {
        output = backend.astify(text);
      } catch (error: unknown) {
        signal.throwIfAborted();
        const decoded = decodeParserError(error, text.length);
        if (decoded === "malformed-output") {
          return malformedOutput(runtime.authority, text);
        }
        if (decoded === "syntax-rejection") {
          return createUnsupportedParserAnalysis(
            runtime.policy === "dialect-compatibility"
              ? "compatibility-rejected"
              : "uncovered-construct",
            text,
            runtime.authority,
          );
        }
        return backendFailure(
          runtime.authority,
          text,
          "node-sql-parser backend failed",
          false,
        );
      }
      signal.throwIfAborted();

      const decoded = decodeRoot(output);
      if (decoded.kind === "unsupported") {
        return createUnsupportedParserAnalysis(
          "uncovered-construct",
          text,
          runtime.authority,
        );
      }
      if (decoded.kind === "malformed") {
        return malformedOutput(runtime.authority, text);
      }

      const artifact = createSqlSyntaxArtifact(
        decoded.statementKind,
        text,
        runtime.authority,
      );
      backendPayloads.set(artifact, decoded.root);
      return createCompatibilityParsedAnalysis(
        artifact,
        runtime.limitations,
      );
    },
  );
}

function createRuntime(
  backendIdentity: SqlSyntaxBackendIdentity,
  loadBackend: NodeSqlParserBackendLoader,
  policy: NodeSqlParserPolicy,
): NodeSqlParserRuntime {
  const authority = createSqlParserAuthority(
    backendIdentity,
    createSqlSyntaxConfigurationIdentity(),
    createSqlDialectSyntaxIdentity(),
  );
  return Object.freeze({
    authority,
    limitations:
      policy === "dialect-compatibility"
        ? DIALECT_COMPATIBILITY_LIMITATIONS
        : TARGET_GRAMMAR_LIMITATIONS,
    loadBackend,
    policy,
  });
}

const postgresqlBackendIdentity = createSqlSyntaxBackendIdentity();
const bigQueryBackendIdentity = createSqlSyntaxBackendIdentity();
const postgresqlBackend = createRetryingBackendLoader(
  importPostgresqlBuild,
);
const bigQueryBackend = createRetryingBackendLoader(importBigQueryBuild);

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
    loadModule: NodeSqlParserModuleLoader,
  ): SqlStatementParser {
    const backendIdentity = createSqlSyntaxBackendIdentity();
    return createAdapter(
      createRuntime(
        backendIdentity,
        createRetryingBackendLoader(loadModule),
        policy,
      ),
    );
  },
  hasBackendPayload(artifact: SqlSyntaxArtifact): boolean {
    return backendPayloads.has(artifact);
  },
  createSynchronousModuleLoader,
});
