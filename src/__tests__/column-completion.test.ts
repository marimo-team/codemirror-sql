import { describe, expect, it } from "vitest";
import {
  composeSqlColumnCompletion,
  composeSqlLocalQueryOutputCompletion,
  filterSqlUsingCompletionList,
  prepareSqlColumnCatalogRelations,
} from "../column-completion.js";
import {
  MAX_COLUMN_BATCH_RELATIONS,
  MAX_COLUMNS_PER_BATCH,
} from "../column-catalog-boundary.js";
import { MAX_QUERY_OUTPUT_COLUMNS } from "../query-output.js";
import type {
  SqlColumnCatalogBatchOutcome,
} from "../column-catalog-batch-coordinator.js";
import type {
  SqlColumnCatalogResolvedColumn,
} from "../column-catalog-types.js";
import type {
  SqlColumnQuerySiteResult,
} from "../column-query-site.js";
import {
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";

type ReadySite = Extract<
  SqlColumnQuerySiteResult,
  { status: "ready" }
>;

const epoch = Object.freeze({ generation: 1, token: "epoch-1" });

function site(
  qualifier: ReadySite["qualifier"] = [],
  prefix = "",
): ReadySite {
  return Object.freeze({
    coverage: "complete",
    context: "select-list",
    issues: Object.freeze([]),
    prefix: Object.freeze({ quoted: false, value: prefix }),
    qualifier: Object.freeze(qualifier),
    relations: Object.freeze([
      Object.freeze({
        alias: Object.freeze({ quoted: false, value: "u" }),
        path: Object.freeze([
          Object.freeze({ quoted: false, value: "app" }),
          Object.freeze({ quoted: false, value: "users" }),
        ]),
        range: Object.freeze({ from: 20, to: 29 }),
      }),
      Object.freeze({
        alias: Object.freeze({ quoted: false, value: "o" }),
        path: Object.freeze([
          Object.freeze({ quoted: false, value: "orders" }),
        ]),
        range: Object.freeze({ from: 35, to: 41 }),
      }),
    ]),
    replacementRange: Object.freeze({ from: 9, to: 9 + prefix.length }),
    status: "ready",
  });
}

function column(
  name: string,
  relationEntityId: string,
  ordinal: number,
): SqlColumnCatalogResolvedColumn {
  return Object.freeze({
    columnEntityId: `${relationEntityId}:${name}`,
    dataType: "VARCHAR",
    identifier: Object.freeze({ quoted: false, value: name }),
    insertText: name,
    ordinal,
    provenance: Object.freeze({
      columnEntityId: `${relationEntityId}:${name}`,
      epoch,
      providerId: "columns",
      relationEntityId,
      scope: "engine:1",
    }),
  });
}

function usable(
  relations: Extract<
    SqlColumnCatalogBatchOutcome,
    { status: "usable" }
  >["relations"],
): Extract<SqlColumnCatalogBatchOutcome, { status: "usable" }> {
  return Object.freeze({
    epoch,
    providerId: "columns",
    relations: Object.freeze(relations),
    scope: "engine:1",
    status: "usable",
  });
}

describe("column completion", () => {
  it("composes bounded local output evidence and degrades missing output", () => {
    const local = (output?: ReadySite["relations"][number]["local"]) =>
      Object.freeze({
        ...site([{ quoted: false, value: "c" }], "i"),
        relations: Object.freeze([
          Object.freeze({
            alias: Object.freeze({ quoted: false, value: "c" }),
            ...(output === undefined ? {} : { local: output }),
            path: Object.freeze([]),
            range: Object.freeze({ from: 20, to: 30 }),
          }),
        ]),
      });
    expect(
      composeSqlLocalQueryOutputCompletion(
        local(),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toBeNull();
    const missing = local(Object.freeze({
      kind: "cte",
      queryRange: Object.freeze({ from: 0, to: 10 }),
    }));
    expect(
      composeSqlLocalQueryOutputCompletion(
        missing,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({
      sources: [{ coverage: "partial" }],
      value: {
        isIncomplete: true,
        items: [],
      },
    });
    const column = Object.freeze({
      definition: Object.freeze({ from: 5, to: 7 }),
      identifier: Object.freeze({ quoted: false, value: "id" }),
      insertText: "id",
    });
    const ready = local(Object.freeze({
      kind: "cte",
      output: Object.freeze({
        columns: Object.freeze([column, column]),
        coverage: "complete",
        status: "ready",
      }),
      queryRange: Object.freeze({ from: 0, to: 10 }),
    }));
    expect(
      composeSqlLocalQueryOutputCompletion(
        ready,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({
      sources: [{ coverage: "complete" }],
      value: { items: [{ label: "id" }] },
    });
    expect(
      composeSqlLocalQueryOutputCompletion(
        Object.freeze({
          ...ready,
          prefix: Object.freeze({ quoted: false, value: "z" }),
        }),
        POSTGRESQL_SQL_RELATION_DIALECT,
      )?.value.items,
    ).toEqual([]);
  });

  it("bounds aggregate local output candidates", () => {
    const output = Object.freeze({
      columns: Object.freeze(Array.from(
        { length: MAX_QUERY_OUTPUT_COLUMNS },
        (_, index) => Object.freeze({
          definition: Object.freeze({ from: index, to: index + 1 }),
          identifier: Object.freeze({
            quoted: false,
            value: `column_${index}`,
          }),
          insertText: `column_${index}`,
        }),
      )),
      coverage: "complete" as const,
      status: "ready" as const,
    });
    const current = Object.freeze({
      ...site(),
      relations: Object.freeze(Array.from(
        {
          length:
            Math.ceil(MAX_COLUMNS_PER_BATCH / MAX_QUERY_OUTPUT_COLUMNS) +
            1,
        },
        (_, index) => Object.freeze({
          alias: Object.freeze({
            quoted: false,
            value: `cte_${index}`,
          }),
          local: Object.freeze({
            kind: "cte" as const,
            output,
            queryRange: Object.freeze({ from: 0, to: 10 }),
          }),
          path: Object.freeze([]),
          range: Object.freeze({ from: index, to: index + 1 }),
        }),
      )),
    });

    expect(
      composeSqlLocalQueryOutputCompletion(
        current,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({
      sources: [{ coverage: "partial" }],
      value: {
        isIncomplete: true,
        items: { length: MAX_COLUMNS_PER_BATCH },
      },
    });
  });

  it("reserves local USING work for the immediate relation pair", () => {
    const unrelatedOutput = Object.freeze({
      columns: Object.freeze(Array.from(
        { length: MAX_QUERY_OUTPUT_COLUMNS },
        (_, index) => Object.freeze({
          definition: Object.freeze({ from: index, to: index + 1 }),
          identifier: Object.freeze({
            quoted: false,
            value: `unrelated_${index}`,
          }),
          insertText: `unrelated_${index}`,
        }),
      )),
      coverage: "complete" as const,
      status: "ready" as const,
    });
    const sharedOutput = Object.freeze({
      columns: Object.freeze([Object.freeze({
        definition: Object.freeze({ from: 0, to: 1 }),
        identifier: Object.freeze({ quoted: false, value: "id" }),
        insertText: "id",
      })]),
      coverage: "complete" as const,
      status: "ready" as const,
    });
    const relation = (
      index: number,
      output: typeof unrelatedOutput | typeof sharedOutput,
    ) => Object.freeze({
      alias: Object.freeze({ quoted: false, value: `r_${index}` }),
      local: Object.freeze({
        kind: "cte" as const,
        output,
        queryRange: Object.freeze({ from: 0, to: 10 }),
      }),
      path: Object.freeze([]),
      range: Object.freeze({ from: index, to: index + 1 }),
    });
    const current = Object.freeze({
      ...site(),
      context: "using" as const,
      relations: Object.freeze([
        ...Array.from(
          { length: 17 },
          (_, index) => relation(index, unrelatedOutput),
        ),
        relation(17, sharedOutput),
        relation(18, sharedOutput),
      ]),
    });
    const composition = composeSqlLocalQueryOutputCompletion(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    expect(composition).not.toBeNull();
    expect(
      composition &&
        filterSqlUsingCompletionList(
          composition.value,
          current,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ).items.map((item) => item.label),
    ).toEqual(["id"]);
  });

  it("bounds relation batches and reports the omitted bindings", () => {
    const relations = Array.from(
      { length: MAX_COLUMN_BATCH_RELATIONS + 1 },
      (_, index) => Object.freeze({
        alias: Object.freeze({
          quoted: false,
          value: `t_${index}`,
        }),
        path: Object.freeze([
          Object.freeze({
            quoted: false,
            value: `table_${index}`,
          }),
        ]),
        range: Object.freeze({ from: index, to: index + 1 }),
      }),
    );
    const current = Object.freeze({
      ...site(),
      relations: Object.freeze(relations),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );

    expect(prepared).toMatchObject({
      coverage: "partial",
      references: { length: MAX_COLUMN_BATCH_RELATIONS },
    });
    expect(composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([]),
      prepared,
      providerId: "columns",
      site: current,
    })).toMatchObject({
      sources: [{ coverage: "partial", outcome: "ready" }],
      value: {
        isIncomplete: true,
        issues: [{ reason: "query-binding-partial" }],
      },
    });
  });

  it("batches only the relation selected by an alias qualifier", () => {
    const current = site([{ quoted: false, value: "u" }], "na");
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );

    expect(prepared.references).toEqual([{
      path: [
        { quoted: false, value: "app" },
        { quoted: false, value: "users" },
      ],
      requestKey: "binding:0",
    }]);
  });

  it("matches an unaliased multipart path suffix", () => {
    const current = Object.freeze({
      ...site([{ quoted: false, value: "app" }, {
        quoted: false,
        value: "users",
      }]),
      relations: Object.freeze([
        Object.freeze({
          alias: null,
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "app" }),
            Object.freeze({ quoted: false, value: "users" }),
          ]),
          range: Object.freeze({ from: 20, to: 29 }),
        }),
      ]),
    });
    expect(
      prepareSqlColumnCatalogRelations(
        current,
        POSTGRESQL_SQL_RELATION_DIALECT,
    ).references,
    ).toHaveLength(1);
  });

  it("offers only the intersection of the immediate USING relations", () => {
    const current = Object.freeze({
      ...site([], "i"),
      context: "using" as const,
      relations: Object.freeze([
        Object.freeze({
          alias: Object.freeze({ quoted: false, value: "u" }),
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "users" }),
          ]),
          range: Object.freeze({ from: 0, to: 5 }),
        }),
        Object.freeze({
          alias: Object.freeze({ quoted: false, value: "o" }),
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "orders" }),
          ]),
          range: Object.freeze({ from: 6, to: 12 }),
        }),
        Object.freeze({
          alias: Object.freeze({ quoted: false, value: "p" }),
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "payments" }),
          ]),
          range: Object.freeze({ from: 13, to: 21 }),
        }),
      ]),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    expect(prepared.references.map((reference) =>
      reference.path[0]?.value
    )).toEqual(["orders", "payments"]);

    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [
            column("id", "orders", 0),
            column("internal_id", "orders", 1),
          ],
          coverage: "complete",
          relationEntityId: "orders",
          requestKey: "binding:1",
          status: "ready",
        },
        {
          columns: [
            column("id", "payments", 0),
            column("invoice_id", "payments", 1),
          ],
          coverage: "complete",
          relationEntityId: "payments",
          requestKey: "binding:2",
          status: "ready",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items.map((item) => item.label)).toEqual(["id"]);
  });

  it("keeps physical self-join identifiers on both USING sides", () => {
    const current = Object.freeze({
      ...site(),
      context: "using" as const,
      relations: Object.freeze([
        Object.freeze({
          alias: Object.freeze({ quoted: false, value: "left_users" }),
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "users" }),
          ]),
          range: Object.freeze({ from: 0, to: 5 }),
        }),
        Object.freeze({
          alias: Object.freeze({ quoted: false, value: "right_users" }),
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "users" }),
          ]),
          range: Object.freeze({ from: 6, to: 12 }),
        }),
      ]),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const shared = column("id", "users", 0);
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [shared],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        {
          columns: [shared],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:1",
          status: "ready",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items.map((item) => item.label)).toEqual(["id"]);
  });

  it("preserves quoted identifier semantics in USING intersections", () => {
    const current = Object.freeze({
      ...site(),
      context: "using" as const,
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const quoted = Object.freeze({
      ...column("quoted-foo", "orders", 1),
      identifier: Object.freeze({ quoted: true, value: "Foo" }),
      insertText: '"Foo"',
    });
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [
            Object.freeze({
              ...column("unquoted-foo", "users", 0),
              identifier: Object.freeze({ quoted: false, value: "Foo" }),
              insertText: "Foo",
            }),
            Object.freeze({
              ...quoted,
              provenance: Object.freeze({
                ...quoted.provenance,
                relationEntityId: "users",
              }),
            }),
          ],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        {
          columns: [quoted],
          coverage: "complete",
          relationEntityId: "orders",
          requestKey: "binding:1",
          status: "ready",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items).toMatchObject([
      {
        edit: { insert: '"Foo"' },
        label: "Foo",
      },
    ]);
  });

  it("composes deterministic exact edits and provenance", () => {
    const current = site([], "na");
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [
            column("nickname", "users", 2),
            column("name", "users", 1),
          ],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        {
          columns: [column("name", "orders", 1)],
          coverage: "complete",
          relationEntityId: "orders",
          requestKey: "binding:1",
          status: "ready",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value).toMatchObject({
      isIncomplete: false,
      items: [
        {
          detail: "VARCHAR — o",
          edit: { from: 9, insert: "name", to: 11 },
          kind: "column",
          label: "name",
          provenance: {
            columnEntityId: "orders:name",
            kind: "column-catalog",
            relationEntityId: "orders",
          },
        },
        {
          detail: "VARCHAR — u",
          label: "name",
        },
      ],
    });
  });

  it("applies physical relation-alias column lists positionally", () => {
    const current = Object.freeze({
      ...site([{ quoted: false, value: "u" }]),
      relations: Object.freeze([
        Object.freeze({
          ...site().relations[0]!,
          columnAliases: Object.freeze({
            columns: Object.freeze([
              Object.freeze({
                definition: Object.freeze({ from: 30, to: 37 }),
                identifier: Object.freeze({
                  quoted: false,
                  value: "renamed",
                }),
                insertText: "renamed",
              }),
            ]),
            coverage: "complete" as const,
          }),
        }),
      ]),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([{
        columns: [column("original", "users", 0)],
        coverage: "complete",
        relationEntityId: "users",
        requestKey: "binding:0",
        status: "ready",
      }]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items).toMatchObject([{
      edit: { insert: "renamed" },
      label: "renamed",
    }]);
  });

  it("reports partial, loading, and failed relation evidence", () => {
    const current = Object.freeze({
      ...site(),
      coverage: "partial" as const,
      issues: Object.freeze(["derived-relation" as const]),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [
            column("id", "users", 0),
            Object.freeze({
              ...column("id", "users", 1),
              columnEntityId: "users:id-alternate",
              insertText: "id_alternate",
              provenance: Object.freeze({
                ...column("id", "users", 1).provenance,
                columnEntityId: "users:id-alternate",
              }),
            }),
          ],
          coverage: "partial",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        { requestKey: "binding:1", status: "loading" },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value).toMatchObject({
      isIncomplete: true,
      issues: [
        { reason: "query-binding-partial" },
        { reason: "column-catalog-partial" },
        { reason: "column-catalog-loading" },
      ],
    });
    expect(result?.sources[0]).toMatchObject({
      feature: "column-catalog",
      outcome: "loading",
    });
  });

  it("maps provider unavailability and suppresses cancellations", () => {
    const current = site();
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: {
          reason: "malformed-response",
          status: "unavailable",
        },
        prepared,
        providerId: "columns",
        site: current,
      }),
    ).toMatchObject({
      value: {
        issues: [{ reason: "column-catalog-malformed" }],
      },
    });
    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: { status: "cancelled" },
        prepared,
        providerId: "columns",
        site: current,
      }),
    ).toBeNull();
    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: { status: "superseded" },
        prepared,
        providerId: "columns",
        site: current,
      }),
    ).toBeNull();
    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: {
          reason: "provider-failed",
          status: "unavailable",
        },
        prepared,
        providerId: "columns",
        site: current,
      }),
    ).toMatchObject({
      value: {
        issues: [{ reason: "column-catalog-failed" }],
      },
    });
  });

  it("fails qualifier matching closed and labels unaliased relations", () => {
    const current = Object.freeze({
      ...site([
        { quoted: false, value: "too" },
        { quoted: false, value: "deep" },
        { quoted: false, value: "path" },
      ]),
      relations: Object.freeze([
        Object.freeze({
          alias: null,
          path: Object.freeze([
            Object.freeze({ quoted: false, value: "app" }),
            Object.freeze({ quoted: false, value: "users" }),
          ]),
          range: Object.freeze({ from: 20, to: 29 }),
        }),
      ]),
    });
    expect(
      prepareSqlColumnCatalogRelations(
        current,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).references,
    ).toEqual([]);

    const unqualified = Object.freeze({
      ...current,
      qualifier: Object.freeze([]),
    });
    const prepared = prepareSqlColumnCatalogRelations(
      unqualified,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const noMetadata = Object.freeze({
      columnEntityId: "users:x",
      identifier: Object.freeze({ quoted: false, value: "x" }),
      insertText: "x",
      ordinal: 0,
      provenance: Object.freeze({
        columnEntityId: "users:x",
        epoch,
        providerId: "columns",
        relationEntityId: "users",
        scope: "engine:1",
      }),
    });
    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: usable([{
          columns: [noMetadata],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        }]),
        prepared,
        providerId: "columns",
        site: unqualified,
      })?.value.items[0],
    ).toMatchObject({
      detail: "app.users",
      label: "x",
    });
  });

  it("contains malformed mappings, duplicates, prefix misses, and failures", () => {
    const current = site([], "i");
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const repeated = column("id", "users", 0);
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [repeated, repeated, column("name", "users", 1)],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        {
          columns: [column("id", "missing", 0)],
          coverage: "complete",
          relationEntityId: "missing",
          requestKey: "unknown",
          status: "ready",
        },
        {
          code: "unavailable",
          requestKey: "binding:1",
          retry: "next-request",
          status: "failed",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result).toMatchObject({
      sources: [{
        coverage: "partial",
        failures: [{
          code: "unavailable",
          requestKey: "binding:1",
          retry: "next-request",
        }],
        outcome: "ready",
      }],
      value: {
        isIncomplete: true,
        issues: [
          { reason: "column-catalog-malformed" },
          { reason: "column-catalog-failed" },
        ],
        items: [{ label: "id" }],
      },
    });

    expect(
      composeSqlColumnCompletion({
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        outcome: usable([{
          code: "unavailable",
          requestKey: "binding:0",
          retry: "next-request",
          status: "failed",
        }]),
        prepared,
        providerId: "columns",
        site: current,
      })?.sources[0],
    ).toMatchObject({
      failures: [{
        code: "unavailable",
        requestKey: "binding:0",
        retry: "next-request",
      }],
      outcome: "failed",
    });
  });

  it("uses deterministic code-unit ordering", () => {
    const current = site();
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([{
        columns: [
          column("ä_value", "users", 0),
          column("z_value", "users", 1),
        ],
        coverage: "complete",
        relationEntityId: "users",
        requestKey: "binding:0",
        status: "ready",
      }]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items.map((item) => item.label)).toEqual([
      "z_value",
      "ä_value",
    ]);
  });

  it("uses relation detail to order columns with equal labels", () => {
    const current = site();
    const prepared = prepareSqlColumnCatalogRelations(
      current,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    const result = composeSqlColumnCompletion({
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      outcome: usable([
        {
          columns: [column("id", "users", 0)],
          coverage: "complete",
          relationEntityId: "users",
          requestKey: "binding:0",
          status: "ready",
        },
        {
          columns: [column("id", "orders", 0)],
          coverage: "complete",
          relationEntityId: "orders",
          requestKey: "binding:1",
          status: "ready",
        },
      ]),
      prepared,
      providerId: "columns",
      site: current,
    });

    expect(result?.value.items.map((item) => item.detail)).toEqual([
      "VARCHAR — o",
      "VARCHAR — u",
    ]);
    expect(result?.value.items.map((item) => item.edit.insert)).toEqual([
      "id",
      "id",
    ]);
  });
});
