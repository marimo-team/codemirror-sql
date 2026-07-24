import type {
  SqlCatalogContext,
  SqlDocumentContext,
  SqlDocumentEdit,
  SqlDocumentUpdate,
  SqlEmbeddedRegion,
  SqlIdentifierComponent,
  OpenSqlDocument,
} from "../../src/vnext/index.js";
import type {
  SqlCanonicalRelationPath,
  SqlCatalogProviderReport,
  SqlCatalogReadyCoverage,
  SqlCatalogRelation,
  SqlCatalogSearchRequest,
  SqlCatalogSearchResponse,
  SqlCompletionCancellationReason,
  SqlCompletionIssue,
  SqlRelationCompletionItem,
  SqlRelationCompletionList,
  SqlRelationCatalogProvider,
  SqlRelationCompletionDialectRuntime,
  SqlRelationCompletionSession,
} from "../../src/vnext/relation-completion-types.js";

interface MarimoSqlContext extends SqlDocumentContext {
  readonly engine: string;
}

const catalog: SqlCatalogContext = {
  scope: "notebook:demo",
  searchPath: [
    [
      { quoted: true, value: "database.with.dot" },
      { quoted: false, value: "main" },
    ],
  ],
};
const context: MarimoSqlContext = {
  catalog,
  dialect: "duckdb",
  engine: "local",
};
declare const maybeContext: MarimoSqlContext | undefined;
declare const maybeDocument: SqlDocumentEdit | undefined;
const regions: readonly SqlEmbeddedRegion[] = [
  { from: 14, language: "python", to: 18 },
];
const openWithoutRegions: OpenSqlDocument<MarimoSqlContext> = {
  context,
  text: "SELECT * FROM users",
};
const openWithRegions: OpenSqlDocument<MarimoSqlContext> = {
  context,
  embeddedRegions: regions,
  text: "SELECT * FROM {df}",
};

declare const session: SqlRelationCompletionSession<MarimoSqlContext>;
session.update({
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT * FROM {next_df}" },
  embeddedRegions: [{ from: 14, language: "python", to: 23 }],
});
session.update({
  baseRevision: session.revision,
  context: { ...context, engine: "remote" },
  document: { kind: "replace", text: "SELECT * FROM remote.users" },
  embeddedRegions: [],
});
session.update({
  baseRevision: session.revision,
  context: { ...context, engine: "remote" },
});
session.update({
  baseRevision: session.revision,
  embeddedRegions: [],
});
session.update({
  baseRevision: session.revision,
  context,
  embeddedRegions: regions,
});
session.update({
  baseRevision: session.revision,
  context: maybeContext,
  document: maybeDocument,
  embeddedRegions: regions,
});

const subscription = session.onDidChange((event) => {
  const reason: "catalog" | "catalog-availability" | "provider-configuration" =
    event.reason;
  session.isCurrent(event.revision);
  void reason;
});
subscription.dispose();
subscription.dispose();
void session.complete({
  position: 14,
  signal: new AbortController().signal,
  trigger: { kind: "invoked" },
});
void session.complete({
  position: 14,
  trigger: { character: ".", kind: "trigger-character" },
}).then((result) => {
  // @ts-expect-error scheduler work identities never enter consumer results
  void result.workId;
  // @ts-expect-error catalog epochs never enter consumer results
  void result.epoch;
});

const provider: SqlRelationCatalogProvider = {
  id: "marimo",
  search: async (request, signal) => {
    signal.throwIfAborted();
    const typedRequest: SqlCatalogSearchRequest = request;
    void typedRequest;
    return {
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    };
  },
  subscribe: (_scope, onInvalidation) => {
    onInvalidation({ epoch: { generation: 1, token: "tables-updated" } });
    return { dispose: () => undefined };
  },
};
void provider;

const relationPath = [
  { quoted: false, role: "catalog", value: "memory" },
  { quoted: false, role: "schema", value: "main" },
  { quoted: false, role: "relation", value: "users" },
] satisfies SqlCanonicalRelationPath;
const relation: SqlCatalogRelation = {
  canonicalPath: relationPath,
  completionPathStart: 1,
  entityId: "users",
  matchQuality: "exact",
  relationKind: "table",
};
void relation;

const dialectRuntime: SqlRelationCompletionDialectRuntime = {
  cteIdentifiersEqual: (left, right) =>
    left.quoted === right.quoted && left.value === right.value,
  decodeIdentifier: (token) => ({
    component: { quoted: false, value: token },
    quality: "exact",
    status: "decoded",
  }),
  renderRelationPath: (path) => ({
    status: "rendered",
    text: path.map((component) => component.value).join("."),
  }),
};
void dialectRuntime;

// @ts-expect-error semantic catalog roles are a closed set
const invalidRole: SqlCatalogRelation["canonicalPath"][number]["role"] =
  "database";
// @ts-expect-error match evidence is provider-proven and closed
const invalidMatch: SqlCatalogRelation["matchQuality"] = "prefix";

const loadingIssue: SqlCompletionIssue = {
  reason: "catalog-loading",
  remainingIntentLeaseMs: 1_000,
};
void loadingIssue;

const flatSearchPath: SqlCatalogContext = {
  scope: "local",
  // @ts-expect-error a search path is a list of decoded components, not a dot string
  searchPath: ["main"],
};
// @ts-expect-error every decoded component records whether it was quoted
const incompleteComponent: SqlIdentifierComponent = { value: "main" };
// @ts-expect-error the old update discriminant is not part of the transaction
session.update({ baseRevision: session.revision, kind: "context", context });
// @ts-expect-error a transaction must change at least one state dimension
session.update({ baseRevision: session.revision });
// @ts-expect-error document changes require the complete resulting region set
session.update({
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 1" },
});
// @ts-expect-error undefined omission leaves an empty transaction
session.update({ baseRevision: session.revision, context: undefined });
const missingEngine: OpenSqlDocument<MarimoSqlContext> = {
  // @ts-expect-error marimo contexts always identify their engine
  context: { dialect: "duckdb" },
  text: "",
};
// @ts-expect-error embedded regions are readonly
regions[0]!.from = 0;
session.onDidChange((event) => {
  // @ts-expect-error service-originated event data is readonly
  event.reason = "catalog";
});
// @ts-expect-error session notifications use a closed reason set
session.onDidChange((_event: { revision: typeof session.revision; reason: "text" }) => {});

const missingRelation = [
  { quoted: false, role: "schema", value: "main" },
  // @ts-expect-error a canonical relation path must end in a relation component
] satisfies SqlCanonicalRelationPath;
// @ts-expect-error paginated coverage requires a continuation token
const missingContinuation: SqlCatalogReadyCoverage = { kind: "paginated" };
const extraContinuation = {
  kind: "complete",
  // @ts-expect-error complete coverage cannot contain a continuation token
  continuationToken: "next",
} satisfies SqlCatalogReadyCoverage;
const leakedRequestState = {
  continuationToken: null,
  dialectId: "duckdb",
  expectedEpoch: null,
  limit: 100,
  prefix: { quoted: false, value: "" },
  qualifier: [],
  scope: "local",
  searchPaths: [],
  // @ts-expect-error caller cancellation is passed separately
  signal: AbortSignal.abort(),
} satisfies SqlCatalogSearchRequest;
const leakedDocumentText = {
  continuationToken: null,
  dialectId: "duckdb",
  expectedEpoch: null,
  limit: 100,
  prefix: { quoted: false, value: "" },
  qualifier: [],
  scope: "local",
  searchPaths: [],
  // @ts-expect-error providers never receive document text
  text: "SELECT * FROM ",
} satisfies SqlCatalogSearchRequest;
const malformedLoading = {
  epoch: { generation: 0, token: "zero" },
  // @ts-expect-error loading responses cannot carry relations
  relations: [],
  status: "loading",
} satisfies SqlCatalogSearchResponse;
const providerRenderedSql = {
  canonicalPath: relationPath,
  completionPathStart: 1,
  entityId: "users",
  // @ts-expect-error providers return decoded paths, never SQL insertion text
  insertText: "main.users",
  matchQuality: "exact",
  relationKind: "table",
} satisfies SqlCatalogRelation;
const leakedProviderFailure = {
  code: "unavailable",
  // @ts-expect-error raw provider errors never cross the completion boundary
  error: new Error("secret"),
  feature: "relation-catalog",
  outcome: "failed",
  providerId: "marimo",
  retry: "next-request",
} satisfies SqlCatalogProviderReport;
const synchronousProvider: SqlRelationCatalogProvider = {
  id: "sync",
  // @ts-expect-error relation catalog providers are asynchronous
  search: () => ({
    epoch: { generation: 0, token: "zero" },
    status: "loading",
  }),
};
// @ts-expect-error catalog-loading always carries its remaining intent lease
const loadingWithoutLease: SqlCompletionIssue = { reason: "catalog-loading" };
const mismatchedItem = {
  edit: { from: 0, insert: "users", to: 0 },
  label: "users",
  provenance: {
    // @ts-expect-error CTE items require CTE provenance
    entityId: "users",
    kind: "catalog",
    providerId: "marimo",
  },
  relationKind: "cte",
} satisfies SqlRelationCompletionItem;
const contradictoryCompleteList = {
  isIncomplete: false,
  // @ts-expect-error complete lists cannot carry incomplete issues
  issues: [{ reason: "catalog-partial" }],
  items: [],
} satisfies SqlRelationCompletionList;
const contradictoryIncompleteList = {
  isIncomplete: true,
  issues: [],
  items: [],
  // @ts-expect-error incomplete lists require at least one issue
} satisfies SqlRelationCompletionList;
// @ts-expect-error timeouts are unavailable evidence, not cancellation
const invalidCancellation: SqlCompletionCancellationReason = "timeout";
const undefinedContext: SqlDocumentUpdate<MarimoSqlContext> = {
  baseRevision: session.revision,
  context: undefined,
  document: undefined,
  embeddedRegions: [],
};

void extraContinuation;
void contradictoryCompleteList;
void contradictoryIncompleteList;
void flatSearchPath;
void incompleteComponent;
void invalidCancellation;
void invalidMatch;
void invalidRole;
void leakedRequestState;
void leakedDocumentText;
void leakedProviderFailure;
void loadingWithoutLease;
void malformedLoading;
void missingContinuation;
void missingEngine;
void missingRelation;
void mismatchedItem;
void openWithRegions;
void openWithoutRegions;
void providerRenderedSql;
void synchronousProvider;
void undefinedContext;
