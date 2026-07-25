import type {
  CompletionSource,
} from "@codemirror/autocomplete";
import type {
  ChangeSpec,
  EditorState,
  StateEffectType,
  TransactionSpec,
} from "@codemirror/state";

import {
  bigQueryDialect,
  createSqlLanguageService,
  dremioDialect,
  duckdbDialect,
  postgresDialect,
  type SqlCanonicalRelationPath,
  type SqlCatalogEpoch,
  type SqlCatalogReadyCoverage,
  type SqlCatalogRelation,
  type SqlCatalogSearchRequest,
  type SqlCatalogSearchResponse,
  type SqlContextInput,
  type SqlDocumentContext,
  type SqlEmbeddedRegion,
  type SqlIdentifierPath,
  type SqlRelationCatalogProvider,
} from "../../src/vnext/index.js";
import {
  sqlEditor,
  type SqlCompletionInfoResolver,
  type SqlEditorSupport,
} from "../../src/vnext/codemirror/index.js";

type VnextDialectId =
  | "bigquery"
  | "dremio"
  | "duckdb"
  | "postgres";

type MarimoBackendDialect =
  | VnextDialectId
  | "postgresql"
  | "mysql"
  | "oracle"
  | "sqlite"
  | "snowflake";

interface MarimoSqlContext extends SqlDocumentContext {
  readonly engine: string;
}

interface MarimoConnection {
  readonly defaultDatabase: string | null;
  readonly defaultSchema: string | null;
  readonly dialect: MarimoBackendDialect;
  readonly engine: string;
  /** Changes whenever a same-named backend connection is replaced. */
  readonly incarnation: number;
}

interface MarimoTableMetadata {
  readonly detail: string;
  readonly entityId: string;
}

interface MarimoCatalogSnapshot {
  readonly epoch: SqlCatalogEpoch;
  readonly relations: readonly SqlCatalogRelation[];
}

declare const catalogByScope:
  ReadonlyMap<string, MarimoCatalogSnapshot>;
declare const tableMetadataById:
  ReadonlyMap<string, MarimoTableMetadata>;
declare const subscribeToCatalogScope: (
  scope: string,
  listener: (epoch: SqlCatalogEpoch) => void,
) => () => void;
declare const searchMarimoCatalogIndex: (
  snapshot: MarimoCatalogSnapshot,
  request: SqlCatalogSearchRequest,
) => {
  readonly coverage: SqlCatalogReadyCoverage;
  readonly relations: readonly SqlCatalogRelation[];
};
declare const variableCompletionSource: CompletionSource;
declare const keywordCompletionSource: CompletionSource;
declare const legacySchemaCompletionSource: CompletionSource;

interface ReactRootLike {
  readonly render: (value: unknown) => void;
  readonly unmount: () => void;
}

declare function createReactRoot(container: Element): ReactRootLike;

function connectionScope(
  connection: MarimoConnection,
): string {
  return `${connection.engine}:${connection.incarnation}`;
}

function identifier(value: string): SqlIdentifierPath[number] {
  return { quoted: false, value };
}

function searchPaths(
  connection: MarimoConnection,
): readonly SqlIdentifierPath[] {
  const path: SqlIdentifierPath[number][] = [];
  if (connection.defaultDatabase !== null) {
    path.push(identifier(connection.defaultDatabase));
  }
  if (connection.defaultSchema !== null) {
    path.push(identifier(connection.defaultSchema));
  }
  return path.length === 0 ? [] : [path];
}

function contextFor(
  route: VnextCompletionRoute,
): SqlContextInput<MarimoSqlContext> {
  const { connection } = route;
  return {
    catalog: {
      scope: connectionScope(connection),
      searchPath: searchPaths(connection),
    },
    dialect: route.dialect,
    engine: connection.engine,
  };
}

const marimoCatalogProvider: SqlRelationCatalogProvider = {
  id: "marimo-datasets",
  search: async (
    request,
    signal,
  ): Promise<SqlCatalogSearchResponse> => {
    signal.throwIfAborted();
    const snapshot = catalogByScope.get(request.scope);
    if (snapshot === undefined) {
      return {
        code: "invalid-configuration",
        epoch: { generation: 0, token: "missing-scope" },
        retry: "after-invalidation",
        status: "failed",
      };
    }
    const result = searchMarimoCatalogIndex(snapshot, request);
    return {
      coverage: result.coverage,
      epoch: snapshot.epoch,
      relations: result.relations,
      status: "ready",
    };
  },
  subscribe: (scope, onInvalidation) => {
    const unsubscribe = subscribeToCatalogScope(scope, (epoch) => {
      onInvalidation({ epoch });
    });
    return (): undefined => {
      unsubscribe();
      return undefined;
    };
  },
};

// One caller-owned service is shared by every SQL editor support/view.
const sharedSqlService =
  createSqlLanguageService<MarimoSqlContext>({
    catalog: marimoCatalogProvider,
    dialects: [
      bigQueryDialect(),
      dremioDialect(),
      duckdbDialect(),
      postgresDialect(),
    ],
  });

const infoResolver: SqlCompletionInfoResolver = (
  item,
  { signal },
) => {
  signal.throwIfAborted();
  if (item.provenance.kind !== "catalog") return null;
  const metadata = tableMetadataById.get(
    item.provenance.entityId,
  );
  if (metadata === undefined) return null;
  const dom = document.createElement("div");
  const root = createReactRoot(dom);
  root.render(metadata.detail);
  return {
    destroy: () => root.unmount(),
    dom,
  };
};

/**
 * Returns the complete, ordered region set for the resulting document.
 * Regions include both braces, matching marimo's current `{python}` syntax.
 */
function pythonTemplateRegions(
  text: string,
): readonly SqlEmbeddedRegion[] {
  const regions: SqlEmbeddedRegion[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== "{") {
      index += 1;
      continue;
    }
    if (text[index + 1] === "{") {
      index += 2;
      continue;
    }
    const close = text.indexOf("}", index + 1);
    const to = close === -1 ? text.length : close + 1;
    if (to > index) {
      regions.push({
        from: index,
        language: "python",
        to,
      });
    }
    index = Math.max(index + 1, to);
  }
  return regions;
}

/**
 * Embedded regions are half-open, so an unmatched expression ending at EOF
 * also needs an insertion-point gate at `doc.length`.
 */
function sqlCompletionPositionAllowed(
  state: EditorState,
  position: number,
): boolean {
  const prefix = state.sliceDoc(0, position);
  let inPython = false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (inPython) {
      if (prefix[index] === "}") inPython = false;
      continue;
    }
    if (
      prefix[index] === "{" &&
      prefix[index + 1] !== "{"
    ) {
      inPython = true;
      continue;
    }
    if (
      prefix[index] === "{" &&
      prefix[index + 1] === "{"
    ) {
      index += 1;
    }
  }
  return !inPython;
}

interface VnextCompletionRoute {
  readonly connection: MarimoConnection;
  readonly dialect: VnextDialectId;
  readonly kind: "vnext";
}

type CompletionRoute =
  | {
      readonly kind: "legacy";
      readonly source: CompletionSource;
    }
  | VnextCompletionRoute;

function completionRoute(
  connection: MarimoConnection,
): CompletionRoute {
  switch (connection.dialect) {
    case "bigquery":
      return { connection, dialect: "bigquery", kind: "vnext" };
    case "dremio":
      return { connection, dialect: "dremio", kind: "vnext" };
    case "duckdb":
      return { connection, dialect: "duckdb", kind: "vnext" };
    case "postgres":
    case "postgresql":
      return { connection, dialect: "postgres", kind: "vnext" };
    case "mysql":
    case "oracle":
    case "sqlite":
    case "snowflake":
      return { kind: "legacy", source: legacySchemaCompletionSource };
  }
}

function createVnextSupport(
  route: VnextCompletionRoute,
  initialText: string,
): SqlEditorSupport<MarimoSqlContext> {
  return sqlEditor({
    autocomplete: {
      defaultKeymap: false,
      externalSources: [
        variableCompletionSource,
        keywordCompletionSource,
      ],
      infoResolver,
      isCompletionPositionAllowed: sqlCompletionPositionAllowed,
    },
    initialContext: contextFor(route),
    initialEmbeddedRegions: pythonTemplateRegions(initialText),
    service: sharedSqlService,
    statementGutter: {
      hideWhenNotFocused: true,
      showInactive: true,
    },
  });
}

interface MarimoSqlMetadata {
  readonly route: VnextCompletionRoute;
}

declare const setMarimoSqlMetadata:
  StateEffectType<MarimoSqlMetadata>;
declare const reconfigureSqlDialect:
  StateEffectType<VnextDialectId>;

/**
 * Marimo owns this transaction seam. `resultingText` is the document after
 * `changes`; all interpretation inputs are emitted in the same transaction.
 */
function atomicSqlInputTransaction(
  support: SqlEditorSupport<MarimoSqlContext>,
  input: {
    readonly changes?: ChangeSpec;
    readonly metadata: MarimoSqlMetadata;
    readonly resultingText: string;
  },
): TransactionSpec {
  const { route } = input.metadata;
  const transaction: TransactionSpec = {
    effects: [
      setMarimoSqlMetadata.of(input.metadata),
      support.contextEffect.of(contextFor(route)),
      reconfigureSqlDialect.of(route.dialect),
      support.embeddedRegionsEffect.of(
        pythonTemplateRegions(input.resultingText),
      ),
    ],
  };
  return input.changes === undefined
    ? transaction
    : { ...transaction, changes: input.changes };
}

declare const duckdbRoute: VnextCompletionRoute;
declare const secondDuckdbRoute: VnextCompletionRoute;
declare const mysqlConnection: MarimoConnection & {
  readonly dialect: "mysql";
};

const firstSupport = createVnextSupport(
  duckdbRoute,
  "SELECT * FROM {df}",
);
const secondSupport = createVnextSupport(
  secondDuckdbRoute,
  "SELECT * FROM users",
);
const atomicSwitch = atomicSqlInputTransaction(firstSupport, {
  changes: { from: 14, insert: "orders", to: 18 },
  metadata: { route: secondDuckdbRoute },
  resultingText: "SELECT * FROM orders",
});
const legacyRoute = completionRoute(mysqlConnection);
if (legacyRoute.kind === "legacy") {
  const source: CompletionSource = legacyRoute.source;
  void source;
}

const relationPath = [
  { quoted: false, role: "catalog", value: "memory" },
  { quoted: false, role: "schema", value: "main" },
  { quoted: false, role: "relation", value: "users" },
] satisfies SqlCanonicalRelationPath;

void atomicSwitch;
void firstSupport;
void marimoCatalogProvider;
void relationPath;
void secondSupport;

// The application, not either editor support, owns the shared service.
sharedSqlService.dispose();
