import {
  createSqlLanguageService,
  defineSqlDialect,
  type SqlDocumentContext,
  type SqlDocumentSession,
  type SqlLanguageService,
  type SqlRevision,
  type SqlTextChange,
} from "../../src/vnext/index.js";

interface HostContext extends SqlDocumentContext {
  readonly engine: string;
}

interface DateContext extends HostContext {
  readonly lastUsed: Date;
}

const dialect = defineSqlDialect({ displayName: "DuckDB", id: "duckdb" });
const service = createSqlLanguageService<HostContext>({ dialects: [dialect] });
const session = service.openDocument({
  context: { dialect: "duckdb", engine: "local" },
  text: "",
});
const revision: SqlRevision = session.revision;

// @ts-expect-error host service cannot be widened and fed a weaker context
const widenedService: SqlLanguageService<SqlDocumentContext> = service;
// @ts-expect-error host session cannot be widened and fed a weaker context
const widenedSession: SqlDocumentSession<SqlDocumentContext> = session;

session.update({
  kind: "context",
  baseRevision: revision,
  context: { dialect: "duckdb", engine: "remote" },
});
session.update({
  kind: "document",
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 1" },
});
session.update({
  kind: "document",
  baseRevision: session.revision,
  context: { dialect: "duckdb", engine: "local" },
  document: { kind: "changes", changes: [{ from: 0, insert: "SELECT 1", to: 0 }] },
});

const change: SqlTextChange = { from: 0, insert: "", to: 0 };

// @ts-expect-error revisions are service-issued opaque values
const objectRevision: SqlRevision = {};
// @ts-expect-error revisions cannot be numbers
const numberRevision: SqlRevision = 1;
// @ts-expect-error updates require document or context
session.update({ kind: "document", baseRevision: revision });
// @ts-expect-error document mutation forms are mutually exclusive
session.update({ kind: "document", baseRevision: revision, document: { kind: "changes", changes: [], text: "" } });
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
// @ts-expect-error session revision is readonly
session.revision = revision;

void objectRevision;
void numberRevision;
void widenedService;
void widenedSession;
