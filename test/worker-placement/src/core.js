import {
  createSqlLanguageService,
  duckdbDialect,
} from "@marimo-team/codemirror-sql/vnext";

const service = createSqlLanguageService({
  dialects: [duckdbDialect()],
});
const session = service.openDocument({
  context: { dialect: "duckdb" },
  text: "SELECT 1",
});

if (!session.isCurrent(session.revision)) {
  throw new Error("The packed core failed its revision identity check");
}

service.dispose();
document.body.dataset.status = "passed";
document.querySelector("#result").textContent = "core-only import passed";
