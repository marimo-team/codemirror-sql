import {
  createSqlLanguageService,
  duckdbDialect,
  type SqlDialect,
  type SqlDocumentContext,
  type SqlDocumentEdit,
  type SqlDocumentSession,
  type SqlEmbeddedRegion,
  type SqlLanguageService,
  type SqlRevision,
  type SqlTextChange,
  type SqlTextRange,
} from "../../src/vnext/index.js";

interface HostContext extends SqlDocumentContext {
  readonly engine: string;
}

interface DateContext extends HostContext {
  readonly lastUsed: Date;
}

interface HostEmbeddedRegion extends SqlEmbeddedRegion {
  readonly hostNodeId: string;
}

const dialect = duckdbDialect();
const typedDialect: SqlDialect = dialect;
const service = createSqlLanguageService<HostContext>({ dialects: [dialect] });
const session = service.openDocument({
  context: { dialect: "duckdb", engine: "local" },
  embeddedRegions: [{ from: 0, language: "python", to: 1 }],
  text: "x",
});
const identitySession = service.openDocument({
  context: { dialect: "duckdb", engine: "local" },
  text: "",
});
const hostRegions: readonly HostEmbeddedRegion[] = [
  { from: 0, hostNodeId: "cell-1", language: "python", to: 1 },
];
const hostOpen = {
  context: { dialect: "duckdb", engine: "local" },
  embeddedRegions: hostRegions,
  hostMetadata: { cellId: "cell-1" },
  text: "x",
};
service.openDocument(hostOpen);
const revision: SqlRevision = session.revision;
declare const maybeContext: HostContext | undefined;
declare const maybeDocument: SqlDocumentEdit | undefined;

// @ts-expect-error host service cannot be widened and fed a weaker context
const widenedService: SqlLanguageService<SqlDocumentContext> = service;
// @ts-expect-error host session cannot be widened and fed a weaker context
const widenedSession: SqlDocumentSession<SqlDocumentContext> = session;

session.update({
  baseRevision: revision,
  context: { dialect: "duckdb", engine: "remote" },
});
session.update({
  embeddedRegions: [],
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 1" },
});
session.update({
  embeddedRegions: [],
  baseRevision: session.revision,
  context: { dialect: "duckdb", engine: "local" },
  document: { kind: "changes", changes: [{ from: 0, insert: "SELECT 1", to: 0 }] },
});
session.update({
  baseRevision: session.revision,
  embeddedRegions: [],
});
const hostUpdate = {
  baseRevision: session.revision,
  embeddedRegions: hostRegions,
  hostMetadata: { cellId: "cell-1" },
};
session.update(hostUpdate);
session.update({
  embeddedRegions: [],
  baseRevision: session.revision,
  context: undefined,
  document: { kind: "replace", text: "SELECT 1" },
});
session.update({
  baseRevision: session.revision,
  context: { dialect: "duckdb", engine: "local" },
  document: undefined,
  embeddedRegions: undefined,
});
session.update({
  baseRevision: session.revision,
  context: undefined,
  document: undefined,
  embeddedRegions: [],
});
session.update({
  baseRevision: session.revision,
  context: maybeContext,
  document: maybeDocument,
  embeddedRegions: hostRegions,
});

const change: SqlTextChange = { from: 0, insert: "", to: 0 };
const range: SqlTextRange = change;

// @ts-expect-error revisions are service-issued opaque values
const objectRevision: SqlRevision = {};
// @ts-expect-error revisions cannot be numbers
const numberRevision: SqlRevision = 1;
// @ts-expect-error updates require a non-empty state change
session.update({ baseRevision: revision });
const legacyUpdate = {
  baseRevision: revision,
  context: { dialect: "duckdb", engine: "local" },
  kind: "context" as const,
};
// @ts-expect-error the removed update discriminant stays forbidden through variables
session.update(legacyUpdate);
// @ts-expect-error document mutations require complete post-edit regions
session.update({
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 2" },
});
// @ts-expect-error document mutations require defined post-edit regions
session.update({
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 2" },
  embeddedRegions: undefined,
});
// @ts-expect-error document mutation forms are mutually exclusive
session.update({ embeddedRegions: [], baseRevision: revision, document: { kind: "changes", changes: [], text: "" } });
// @ts-expect-error host context requires engine
service.openDocument({ context: { dialect: "duckdb" }, text: "" });
const dateService = createSqlLanguageService<DateContext>({ dialects: [dialect] });
dateService.openDocument({
  // @ts-expect-error Date is structured-cloneable but is not plain context data
  context: { dialect: "duckdb", engine: "local", lastUsed: new Date() },
  text: "",
});
// @ts-expect-error changes are readonly
change.from = 1;
// @ts-expect-error ranges are readonly
range.to = 1;
const embeddedRegion: SqlEmbeddedRegion = {
  from: 0,
  language: "python",
  to: 1,
};
// @ts-expect-error embedded regions are readonly
embeddedRegion.language = "jinja";
// @ts-expect-error session revision is readonly
session.revision = revision;
// @ts-expect-error statement indexes remain an internal session detail
session.getStatementIndexForTesting();
// @ts-expect-error dialect IDs are readonly
dialect.id = "other";
// @ts-expect-error structural dialect objects are not authentic handles
createSqlLanguageService({ dialects: [{ id: "duckdb", displayName: "DuckDB" }] });

void objectRevision;
void numberRevision;
void range;
void embeddedRegion;
void identitySession;
void typedDialect;
void widenedService;
void widenedSession;
