import { bench, describe } from "vitest";
import {
  createSqlColumnCatalogBatchCoordinator,
} from "../column-catalog-batch-coordinator.js";
import type {
  SqlColumnCatalogBatchRequest,
} from "../column-catalog-types.js";

const epoch = Object.freeze({ generation: 1, token: "bench" });
const relations = Object.freeze(
  Array.from({ length: 64 }, (_, index) =>
    Object.freeze({
      path: Object.freeze([
        Object.freeze({
          quoted: false,
          value: `relation_${index}`,
        }),
      ]),
      requestKey: `relation_${index}`,
    })
  ),
);
const searchPaths = Object.freeze([
  Object.freeze([
    Object.freeze({ quoted: false, value: "main" }),
  ]),
]);

function response(request: SqlColumnCatalogBatchRequest) {
  return Object.freeze({
    epoch,
    relations: Object.freeze(request.relations.map((relation) =>
      Object.freeze({
        columns: Object.freeze(
          Array.from({ length: 64 }, (_, ordinal) =>
            Object.freeze({
              columnEntityId:
                `${relation.requestKey}:column:${ordinal}`,
              identifier: Object.freeze({
                quoted: false,
                value: `column_${ordinal}`,
              }),
              insertText: `column_${ordinal}`,
              ordinal,
            })
          ),
        ),
        coverage: "complete",
        relationEntityId: `entity:${relation.requestKey}`,
        requestKey: relation.requestKey,
        status: "ready",
      })
    )),
  });
}

function owner() {
  const created = createSqlColumnCatalogBatchCoordinator({
    maxCacheEntries: 128,
    provider: {
      id: "benchmark",
      loadColumns: (request: SqlColumnCatalogBatchRequest) =>
        Promise.resolve(response(request)),
    },
  });
  if (created.status !== "created") throw new Error("coordinator");
  const prepared = created.coordinator.prepareOwner({
    dialectId: "duckdb",
    scope: "benchmark",
  });
  if (prepared.status !== "prepared") throw new Error("owner");
  return prepared.owner;
}

describe("column catalog batch coordinator", () => {
  bench("cold 64 relation x 64 column batch", async () => {
    const current = owner();
    await current.request({
      expectedEpoch: null,
      relations,
      searchPaths,
    }).result;
    current.dispose();
  });

  const warmOwner = owner();
  const warmReady = warmOwner.request({
    expectedEpoch: epoch,
    relations,
    searchPaths,
  }).result;

  bench("warm 64 relation cache projection", async () => {
    await warmReady;
    await warmOwner.request({
      expectedEpoch: epoch,
      relations,
      searchPaths,
    }).result;
  });
});
