import {
  createSqlLanguageService,
  duckdbDialect,
  type SqlDiagnostic,
  type SqlDocumentContext,
  type SqlLanguageFeatureProvider,
} from "../../src/index.js";

interface HostContext extends SqlDocumentContext {
  readonly connection: string;
}

const provider: SqlLanguageFeatureProvider<HostContext> = {
  id: "host",
  diagnostics: ({ document, request, signal }) => {
    const connection: string = document.context.connection;
    const dialect: string = document.dialect;
    const range = request.range;
    const aborted: boolean = signal.aborted;
    void connection;
    void dialect;
    void range;
    void aborted;
    return [{
      from: 0,
      message: "message",
      severity: "warning",
      source: "host",
      to: 1,
    }];
  },
  rename: ({ request }) => ({
    changes: [{
      from: request.position,
      insert: request.newName,
      to: request.position,
    }],
  }),
};

const service = createSqlLanguageService<HostContext>({
  dialects: [duckdbDialect()],
  featureProviders: [provider],
});
const session = service.openDocument({
  context: {
    connection: "local",
    dialect: "duckdb",
  },
  text: "select 1",
});

const diagnostics = await session.diagnostics().result;
if (diagnostics.status === "ready") {
  const item: SqlDiagnostic | undefined = diagnostics.value[0];
  void item;
}

const hoverTask = session.hover({ position: 1 });
hoverTask.cancel();
const renameTask = session.rename({ newName: "answer", position: 1 });
void renameTask.result;
