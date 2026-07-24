const GLOBAL_KEYS = ["NodeSQLParser", "global"];
const MAX_STATEMENT_LENGTH = 16 * 1024;
const PARSER_OPTIONS = Object.freeze({
  parseOptions: Object.freeze({
    includeLocations: true,
  }),
  trimQuery: false,
});

function readOwnDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { kind: "missing" };
  }
  if (!("value" in descriptor)) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value };
}

function moduleCandidates(moduleValue) {
  if (
    (typeof moduleValue !== "object" || moduleValue === null) &&
    typeof moduleValue !== "function"
  ) {
    return [moduleValue];
  }
  const candidates = [moduleValue];
  for (const key of ["default", "module.exports"]) {
    const property = readOwnDataProperty(moduleValue, key);
    if (property.kind === "value") {
      candidates.push(property.value);
    }
  }
  return candidates;
}

function findParserConstructor(moduleValue) {
  for (const candidate of moduleCandidates(moduleValue)) {
    if (typeof candidate === "function") {
      return candidate;
    }
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const parser = readOwnDataProperty(candidate, "Parser");
    if (parser.kind === "value" && typeof parser.value === "function") {
      return parser.value;
    }
  }
  throw new Error("The dialect bundle did not expose a Parser constructor");
}

function snapshotGlobals() {
  return GLOBAL_KEYS.map((key) => ({
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    key,
  }));
}

function restoreGlobals(snapshots) {
  for (const { descriptor, key } of snapshots) {
    if (descriptor === undefined) {
      if (!Reflect.deleteProperty(globalThis, key)) {
        throw new Error(`Could not remove worker global ${key}`);
      }
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

function assertDedicatedWorkerRealm() {
  if (
    globalThis.self !== globalThis ||
    "window" in globalThis ||
    "document" in globalThis
  ) {
    throw new Error("Parser fixture did not start in a dedicated worker");
  }
}

export function installParserWorker(loadModule) {
  assertDedicatedWorkerRealm();
  let parserPromise;

  async function getParser() {
    if (parserPromise === undefined) {
      parserPromise = (async () => {
        const snapshots = snapshotGlobals();
        let moduleValue;
        let loadError;
        try {
          moduleValue = await loadModule();
        } catch (error) {
          loadError = error;
        }
        restoreGlobals(snapshots);
        if (loadError !== undefined) {
          throw loadError;
        }
        const Parser = findParserConstructor(moduleValue);
        const parser = Reflect.construct(Parser, []);
        if (
          typeof parser !== "object" ||
          parser === null ||
          typeof parser.astify !== "function"
        ) {
          throw new Error("The dialect Parser did not expose astify");
        }
        return parser;
      })();
    }
    return await parserPromise;
  }

  globalThis.addEventListener("message", async (event) => {
    const request = event.data;
    if (
      typeof request !== "object" ||
      request === null ||
      !Number.isSafeInteger(request.id) ||
      request.id < 0 ||
      typeof request.text !== "string" ||
      request.text.length > MAX_STATEMENT_LENGTH
    ) {
      globalThis.postMessage({
        error: "invalid-request",
        id:
          typeof request === "object" &&
          request !== null &&
          Number.isSafeInteger(request.id)
            ? request.id
            : -1,
        status: "failed",
      });
      return;
    }

    const startedAt = performance.now();
    try {
      const parser = await getParser();
      const output = parser.astify(request.text, PARSER_OPTIONS);
      const root = Array.isArray(output) ? output[0] : output;
      if (
        typeof root !== "object" ||
        root === null ||
        typeof root.type !== "string"
      ) {
        throw new Error("The dialect parser returned no typed AST root");
      }
      globalThis.postMessage({
        astType: root.type,
        id: request.id,
        parseMs: performance.now() - startedAt,
        status: "parsed",
      });
    } catch {
      globalThis.postMessage({
        error: "parse-failed",
        id: request.id,
        status: "failed",
      });
    }
  });
}
