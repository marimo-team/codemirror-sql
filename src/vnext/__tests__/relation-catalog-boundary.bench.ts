import { bench, describe } from "vitest";
import { decodeSqlCatalogSearchResponse } from "../relation-catalog-boundary.js";
import {
  DREMIO_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";

function relation(index: number) {
  return {
    canonicalPath: [
      { quoted: false, role: "schema", value: "public" },
      {
        quoted: false,
        role: "relation",
        value: `relation_${index}`,
      },
    ],
    completionPathStart: 0,
    detail: `Relation ${index}`,
    entityId: `relation-${index}`,
    matchQuality: "exact",
    relationKind: "table",
  };
}

function response(relations: readonly unknown[]) {
  return {
    coverage: { kind: "complete" },
    epoch: { generation: 1, token: "snapshot-1" },
    relations,
    status: "ready",
  };
}

const emptyResponse = response([]);
const oneResponse = response([relation(0)]);
const hundredResponse = response(
  Array.from({ length: 100 }, (_, index) => relation(index)),
);
const malformedLastResponse = response([
  ...Array.from({ length: 99 }, (_, index) => relation(index)),
  { ...relation(99), completionPathStart: 9 },
]);
const oversizedTextResponse = response([
  { ...relation(0), detail: "x".repeat(1_000_000) },
]);
const maximumDepthResponse = response(
  Array.from({ length: 7 }, (_, relationIndex) => ({
    ...relation(relationIndex),
    canonicalPath: Array.from({ length: 32 }, (_, pathIndex) => ({
      quoted: true,
      role: pathIndex === 31 ? "relation" : "schema",
      value: String(relationIndex).repeat(256),
    })),
    detail: "d".repeat(1_024),
    entityId: `maximum-depth-${relationIndex}`,
  })),
);
const wideInvalidResponse = Object.fromEntries(
  Array.from({ length: 10_000 }, (_, index) => [
    `unexpected-${index}`,
    index,
  ]),
);

for (const [candidate, expectedStatus] of [
  [emptyResponse, "accepted"],
  [oneResponse, "accepted"],
  [hundredResponse, "accepted"],
  [malformedLastResponse, "malformed"],
  [oversizedTextResponse, "malformed"],
] as const) {
  const result = decodeSqlCatalogSearchResponse(
    candidate,
    100,
    POSTGRESQL_SQL_RELATION_DIALECT,
  );
  if (result.status !== expectedStatus) {
    throw new Error("Catalog boundary benchmark preflight failed");
  }
}
if (
  decodeSqlCatalogSearchResponse(
    maximumDepthResponse,
    100,
    DREMIO_SQL_RELATION_DIALECT,
  ).status !== "accepted" ||
  decodeSqlCatalogSearchResponse(
    wideInvalidResponse,
    100,
    POSTGRESQL_SQL_RELATION_DIALECT,
  ).status !== "malformed"
) {
  throw new Error("Catalog boundary benchmark preflight failed");
}

describe("relation catalog boundary", () => {
  bench("decode empty ready response", () => {
    decodeSqlCatalogSearchResponse(
      emptyResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  bench("decode one relation", () => {
    decodeSqlCatalogSearchResponse(
      oneResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  bench("decode 100 relations", () => {
    decodeSqlCatalogSearchResponse(
      hundredResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  bench("reject malformed final relation", () => {
    decodeSqlCatalogSearchResponse(
      malformedLastResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  bench("reject a million-unit detail before scanning it", () => {
    decodeSqlCatalogSearchResponse(
      oversizedTextResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  bench("decode near-limit maximum-depth relations", () => {
    decodeSqlCatalogSearchResponse(
      maximumDepthResponse,
      100,
      DREMIO_SQL_RELATION_DIALECT,
    );
  });

  bench("reject a wide unexpected record", () => {
    decodeSqlCatalogSearchResponse(
      wideInvalidResponse,
      100,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });
});
