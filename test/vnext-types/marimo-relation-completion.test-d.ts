import type { SqlEmbeddedRegion } from "../../src/vnext/source.js";
import type {
  SqlCatalogContext,
  SqlDocumentContext,
  SqlIdentifierComponent,
} from "../../src/vnext/index.js";
import type {
  SqlCanonicalRelationPath,
  SqlCatalogReadyCoverage,
  SqlCatalogRelation,
  SqlCatalogSearchRequest,
  SqlCatalogSearchResponse,
  SqlCompletionIssue,
  SqlRelationCatalogProvider,
  SqlRelationCompletionDocumentTransaction,
  SqlRelationCompletionOpenDocument,
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
const regions = [
  { from: 14, language: "python", to: 18 },
] satisfies readonly SqlEmbeddedRegion[];
const openWithoutRegions: SqlRelationCompletionOpenDocument<MarimoSqlContext> = {
  context,
  text: "SELECT * FROM users",
};
const openWithRegions: SqlRelationCompletionOpenDocument<MarimoSqlContext> = {
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

const subscription = session.onDidChange((event) => {
  const reason: "catalog" | "catalog-availability" | "provider-configuration" =
    event.reason;
  session.isCurrent(event.revision);
  void reason;
});
subscription.dispose();
subscription.dispose();
void session.complete(
  { position: 14, trigger: "explicit" },
  new AbortController().signal,
);
void session.complete({ position: 14, trigger: "automatic" }).then((result) => {
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
// @ts-expect-error present undefined is not omission
session.update({ baseRevision: session.revision, context: undefined });
const missingEngine: SqlRelationCompletionOpenDocument<MarimoSqlContext> = {
  // @ts-expect-error marimo contexts always identify their engine
  context: { dialect: "duckdb" },
  text: "",
};
// @ts-expect-error embedded regions are readonly
regions[0].from = 0;
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
// @ts-expect-error a document transaction cannot explicitly omit context
const undefinedContext: SqlRelationCompletionDocumentTransaction<MarimoSqlContext> = {
  baseRevision: session.revision,
  context: undefined,
  embeddedRegions: [],
};

void extraContinuation;
void flatSearchPath;
void incompleteComponent;
void leakedRequestState;
void leakedDocumentText;
void loadingWithoutLease;
void malformedLoading;
void missingContinuation;
void missingEngine;
void missingRelation;
void openWithRegions;
void openWithoutRegions;
void synchronousProvider;
void undefinedContext;
