import { beforeAll, bench, describe } from "vitest";
import {
  createSqlNamespaceCatalogCoordinator,
} from "../namespace-catalog-coordinator.js";
import type {
  SqlNamespaceCatalogSearchRequest,
} from "../namespace-catalog-types.js";

const epoch = Object.freeze({ generation: 1, token: "bench" });

function response(request: SqlNamespaceCatalogSearchRequest) {
  return {
    containers: Array.from({ length: 100 }, (_, index) => ({
      canonicalPath: [
        { quoted: false, role: "catalog", value: "memory" },
        { quoted: false, role: "schema", value: `schema_${index}` },
      ],
      containerEntityId: `schema:${index}`,
      insertText: `schema_${index}`,
      matchQuality: "exact",
    })),
    coverage: "complete",
    epoch: request.expectedEpoch ?? epoch,
    status: "ready",
  };
}

function owner() {
  const created = createSqlNamespaceCatalogCoordinator({
    provider: {
      id: "benchmark",
      search: (request: SqlNamespaceCatalogSearchRequest) =>
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

const search = Object.freeze({
  expectedEpoch: epoch,
  limit: 100,
  prefix: Object.freeze({ quoted: false, value: "schema" }),
  qualifier: Object.freeze([
    Object.freeze({ quoted: false, value: "memory" }),
  ]),
  searchPaths: Object.freeze([]),
});

describe("namespace catalog coordinator", () => {
  bench("cold 100-container search", async () => {
    const current = owner();
    await current.request(search).result;
    current.dispose();
  });

  const warm = owner();
  const primed = warm.request(search).result;
  beforeAll(async () => {
    await primed;
  });

  bench("warm 100-container cache lookup", async () => {
    await warm.request(search).result;
  });
});
