import {
  MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH,
  type SqlStatementKind,
} from "./syntax.js";

export const MAX_NODE_SQL_PARSER_STATEMENT_LENGTH = 16 * 1024;

const MAX_BACKEND_TYPE_LENGTH = 128;
const NODE_SQL_PARSER_OPTIONS = Object.freeze({
  parseOptions: Object.freeze({
    includeLocations: true,
  }),
  trimQuery: false,
});

export type NodeSqlParserModuleLoadOutcome =
  | {
      readonly kind: "loaded";
      readonly moduleValue: unknown;
    }
  | {
      readonly kind: "failed";
      readonly code: "backend" | "module-load";
      readonly retryable: boolean;
    };

export type NodeSqlParserModuleLoader =
  () => Promise<NodeSqlParserModuleLoadOutcome>;

export type NodeSqlParserBackendOutcome =
  | {
      readonly kind: "parsed";
      readonly root: object;
      readonly statementKind: SqlStatementKind;
    }
  | {
      readonly kind: "syntax-rejected";
    }
  | {
      readonly kind: "unsupported";
      readonly reason: "multiple-statements" | "resource-limit";
    }
  | {
      readonly kind: "failed";
      readonly code:
        | "backend"
        | "malformed-output"
        | "module-load";
      readonly retryable: boolean;
    };

export interface NodeSqlParserBackend {
  readonly parse: (
    statementText: string,
    checkpoint?: () => void,
  ) => Promise<NodeSqlParserBackendOutcome>;
}

interface DecodedBackend {
  readonly astify: (statementText: string) => unknown;
}

type BackendLoadOutcome =
  | {
      readonly kind: "loaded";
      readonly backend: DecodedBackend;
    }
  | Extract<NodeSqlParserBackendOutcome, { readonly kind: "failed" }>;

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

function failed(
  code: Extract<
    NodeSqlParserBackendOutcome,
    { readonly kind: "failed" }
  >["code"],
  retryable: boolean,
): Extract<
  NodeSqlParserBackendOutcome,
  { readonly kind: "failed" }
> {
  return Object.freeze({
    code,
    kind: "failed",
    retryable,
  });
}

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
    if (
      parser.kind === "value" &&
      typeof parser.value === "function"
    ) {
      return parser.value;
    }
  }
  return null;
}

function decodeBackendModule(moduleValue: unknown): BackendLoadOutcome {
  const Parser = findParserConstructor(moduleValue);
  if (typeof Parser !== "function") {
    return failed("malformed-output", false);
  }
  let parser: object;
  try {
    parser = Reflect.construct(Parser, []);
  } catch {
    return failed("backend", false);
  }
  const astify = readDataMethod(parser, "astify");
  if (astify === null) {
    return failed("malformed-output", false);
  }
  return Object.freeze({
    backend: Object.freeze({
      astify(statementText: string): unknown {
        return astify(statementText, NODE_SQL_PARSER_OPTIONS);
      },
    }),
    kind: "loaded",
  });
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

function decodeRoot(
  value: unknown,
): Exclude<NodeSqlParserBackendOutcome, {
  readonly kind: "syntax-rejected";
}> {
  let root = value;
  let rootIsArray: boolean;
  try {
    rootIsArray = Array.isArray(root);
  } catch {
    return failed("malformed-output", false);
  }
  if (rootIsArray && isRecordObject(root)) {
    const length = readOwnDataProperty(root, "length");
    if (length.kind !== "value") {
      return failed("malformed-output", false);
    }
    if (length.value !== 1) {
      return Object.freeze({
        kind: "unsupported",
        reason: "multiple-statements",
      });
    }
    const first = readOwnDataProperty(root, 0);
    if (first.kind !== "value") {
      return failed("malformed-output", false);
    }
    root = first.value;
  }
  if (!isRecordObject(root)) {
    return failed("malformed-output", false);
  }
  const type = readOwnDataProperty(root, "type");
  if (
    type.kind !== "value" ||
    typeof type.value !== "string" ||
    type.value.length === 0 ||
    type.value.length > MAX_BACKEND_TYPE_LENGTH ||
    type.value.trim() !== type.value
  ) {
    return failed("malformed-output", false);
  }
  return Object.freeze({
    kind: "parsed",
    root,
    statementKind: mapStatementKind(type.value),
  });
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
): Exclude<NodeSqlParserBackendOutcome, {
  readonly kind: "parsed";
}> {
  if (!isObjectLike(error)) {
    return failed("backend", false);
  }
  const name = readOwnDataProperty(error, "name");
  if (
    name.kind !== "value" ||
    name.value !== "SyntaxError"
  ) {
    return failed("backend", false);
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
    return failed("malformed-output", false);
  }
  const start = readOwnDataProperty(location.value, "start");
  const end = readOwnDataProperty(location.value, "end");
  if (
    start.kind !== "value" ||
    end.kind !== "value" ||
    !isRecordObject(start.value) ||
    !isRecordObject(end.value)
  ) {
    return failed("malformed-output", false);
  }
  const startOffset = readOwnDataProperty(start.value, "offset");
  const endOffset = readOwnDataProperty(end.value, "offset");
  if (
    startOffset.kind !== "value" ||
    endOffset.kind !== "value"
  ) {
    return failed("malformed-output", false);
  }
  const from = decodeSafeOffset(startOffset.value, statementLength);
  const to = decodeSafeOffset(endOffset.value, statementLength);
  if (from === null || to === null || from > to) {
    return failed("malformed-output", false);
  }
  return Object.freeze({
    kind: "syntax-rejected",
  });
}

export function createNodeSqlParserBackend(
  loadModule: NodeSqlParserModuleLoader,
): NodeSqlParserBackend {
  let pending: Promise<BackendLoadOutcome> | undefined;

  async function loadBackend(): Promise<BackendLoadOutcome> {
    if (pending !== undefined) {
      return await pending;
    }
    const current = Promise.resolve()
      .then(loadModule)
      .then((outcome): BackendLoadOutcome => {
        if (outcome.kind === "failed") {
          return failed(outcome.code, outcome.retryable);
        }
        return decodeBackendModule(outcome.moduleValue);
      })
      .catch(() => failed("module-load", true));
    pending = current;
    const outcome = await current;
    if (
      outcome.kind === "failed" &&
      outcome.retryable &&
      pending === current
    ) {
      pending = undefined;
    }
    return outcome;
  }

  return Object.freeze({
    async parse(
      statementText: string,
      checkpoint?: () => void,
    ): Promise<NodeSqlParserBackendOutcome> {
      if (
        statementText.length >
        MAX_NODE_SQL_PARSER_STATEMENT_LENGTH
      ) {
        return Object.freeze({
          kind: "unsupported",
          reason: "resource-limit",
        });
      }

      checkpoint?.();
      const loaded = await loadBackend();
      checkpoint?.();
      if (loaded.kind === "failed") {
        return loaded;
      }

      let output: unknown;
      try {
        output = loaded.backend.astify(statementText);
      } catch (error: unknown) {
        checkpoint?.();
        return decodeParserError(error, statementText.length);
      }
      checkpoint?.();
      return decodeRoot(output);
    },
  });
}
