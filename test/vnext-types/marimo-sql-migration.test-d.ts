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
  type SqlColumnCatalogBatchRequest,
  type SqlColumnCatalogProvider,
  type SqlContextInput,
  type SqlDocumentContext,
  type SqlEmbeddedRegion,
  type SqlIdentifierComponent,
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

interface MarimoColumnMetadata {
  readonly columnEntityId: string;
  readonly detail: string;
  readonly relationEntityId: string;
}

interface MarimoCatalogSnapshot {
  readonly epoch: SqlCatalogEpoch;
  readonly relations: readonly SqlCatalogRelation[];
}

interface MarimoDataTableColumn {
  readonly columnEntityId: string;
  readonly dataType?: string;
  readonly detail?: string;
  readonly identifier: SqlIdentifierComponent;
  readonly insertText: string;
  readonly ordinal: number;
}

type MarimoDataTableColumnResult =
  | {
      readonly columns: readonly MarimoDataTableColumn[];
      readonly coverage: "complete" | "partial";
      readonly relationEntityId: string;
      readonly requestKey: string;
      readonly status: "ready";
    }
  | {
      readonly requestKey: string;
      readonly status: "loading";
    }
  | {
      readonly code:
        | "authentication"
        | "authorization"
        | "invalid-configuration"
        | "rate-limited"
        | "unavailable"
        | "unknown";
      readonly requestKey: string;
      readonly retry: "after-invalidation" | "never" | "next-request";
      readonly status: "failed";
    };

interface MarimoDataTableColumnBatch {
  readonly epoch: SqlCatalogEpoch;
  readonly relations: readonly MarimoDataTableColumnResult[];
}

interface MarimoNamespaceProjection {
  readonly entityId: string;
  readonly kind: "catalog" | "dataset" | "project" | "schema";
  readonly path: SqlIdentifierPath;
  readonly scope: string;
}

declare const catalogByScope:
  ReadonlyMap<string, MarimoCatalogSnapshot>;
declare const tableMetadataById:
  ReadonlyMap<string, MarimoTableMetadata>;
declare const columnMetadataByProvenance:
  ReadonlyMap<string, MarimoColumnMetadata>;
declare const namespaceProjectionByScope:
  ReadonlyMap<string, readonly MarimoNamespaceProjection[]>;
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
declare const loadMarimoDataTableColumnBatch: (
  request: SqlColumnCatalogBatchRequest,
  signal: AbortSignal,
) => Promise<MarimoDataTableColumnBatch>;
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

const marimoColumnProvider: SqlColumnCatalogProvider = {
  id: "marimo-datatable-columns",
  loadColumns: async (request, signal) => {
    signal.throwIfAborted();
    const batch = await loadMarimoDataTableColumnBatch(request, signal);
    signal.throwIfAborted();
    return {
      epoch: batch.epoch,
      relations: batch.relations.map((result) => {
        if (result.status !== "ready") return result;
        return {
          columns: result.columns.map((column) => ({
            columnEntityId: column.columnEntityId,
            identifier: column.identifier,
            insertText: column.insertText,
            ordinal: column.ordinal,
            ...(column.dataType === undefined
              ? {}
              : { dataType: column.dataType }),
            ...(column.detail === undefined
              ? {}
              : { detail: column.detail }),
          })),
          coverage: result.coverage,
          relationEntityId: result.relationEntityId,
          requestKey: result.requestKey,
          status: result.status,
        };
      }),
    };
  },
};

// One caller-owned service is shared by every SQL editor support/view.
const sharedSqlService =
  createSqlLanguageService<MarimoSqlContext>({
    catalog: marimoCatalogProvider,
    columns: marimoColumnProvider,
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
  const metadata = item.provenance.kind === "catalog"
    ? tableMetadataById.get(item.provenance.entityId)
    : item.provenance.kind === "column-catalog"
    ? columnMetadataByProvenance.get(
      `${item.provenance.scope}\0${item.provenance.relationEntityId}\0${item.provenance.columnEntityId}`,
    )
    : undefined;
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

const coldColumnBatch = {
  dialectId: "duckdb",
  expectedEpoch: null,
  relations: [
    {
      path: [
        { quoted: false, value: "main" },
        { quoted: false, value: "users" },
      ],
      relationEntityId: "connection:users",
      requestKey: "binding:users",
    },
    {
      path: [
        { quoted: false, value: "main" },
        { quoted: false, value: "orders" },
      ],
      relationEntityId: "connection:orders",
      requestKey: "binding:orders",
    },
  ],
  searchPaths: [[{ quoted: false, value: "main" }]],
  scope: "duckdb:42",
} satisfies SqlColumnCatalogBatchRequest;

const columnProviderStateExamples = [
  {
    columns: [{
      columnEntityId: "connection:users:customer-id",
      dataType: "VARCHAR",
      detail: "Customer identifier",
      identifier: { quoted: true, value: "customer id" },
      insertText: '"customer id"',
      ordinal: 0,
    }],
    coverage: "partial",
    relationEntityId: "connection:users",
    requestKey: "binding:users",
    status: "ready",
  },
  {
    requestKey: "binding:orders",
    status: "loading",
  },
  {
    code: "authorization",
    requestKey: "binding:private-orders",
    retry: "after-invalidation",
    status: "failed",
  },
] satisfies readonly MarimoDataTableColumnResult[];

void atomicSwitch;
void coldColumnBatch;
void columnProviderStateExamples;
void firstSupport;
void marimoCatalogProvider;
void marimoColumnProvider;
void namespaceProjectionByScope;
void relationPath;
void secondSupport;

// The application, not either editor support, owns the shared service.
sharedSqlService.dispose();
