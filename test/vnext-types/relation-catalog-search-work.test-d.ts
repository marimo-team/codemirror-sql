import type {
  CapturedSqlRelationCatalogProvider,
  SqlValidatedCatalogSearchResponse,
} from "../../src/vnext/relation-catalog-boundary.js";
import type {
  SqlCatalogRevisionTarget,
} from "../../src/vnext/relation-catalog-epoch-coordinator.js";
import type {
  SqlCatalogSearchWorkCoordinator,
  SqlCatalogSearchWorkInput,
  SqlCatalogSearchWorkOutcome,
  SqlCatalogSearchWorkOwner,
  SqlCatalogSearchWorkOwnerResult,
  SqlCatalogSearchWorkTicket,
} from "../../src/vnext/relation-catalog-search-work.js";
import {
  createSqlCatalogSearchWorkCoordinator,
} from "../../src/vnext/relation-catalog-search-work.js";
import type {
  SqlRelationDialectRuntime,
} from "../../src/vnext/relation-dialect.js";

declare const capturedProvider: CapturedSqlRelationCatalogProvider;
declare const coordinator: SqlCatalogSearchWorkCoordinator;
declare const dialect: SqlRelationDialectRuntime;
declare const owner: SqlCatalogSearchWorkOwner;
declare const target: SqlCatalogRevisionTarget;
declare const response: SqlValidatedCatalogSearchResponse;
declare const ticket: SqlCatalogSearchWorkTicket;

const input: SqlCatalogSearchWorkInput = {
  continuationToken: null,
  limit: 25,
  prefix: { quoted: false, value: "ord" },
  qualifier: [{ quoted: false, value: "analytics" }],
  searchPaths: [
    [
      { quoted: false, value: "warehouse" },
      { quoted: false, value: "public" },
    ],
  ],
};

const created = createSqlCatalogSearchWorkCoordinator(
  capturedProvider,
);
if (created.status === "created") {
  const prepared = created.coordinator.prepareOwner(
    "notebook:demo",
    "duckdb",
    dialect,
    target,
  );
  if (prepared.status === "prepared") {
    const activation = prepared.owner.activate();
    if (activation.status === "active") {
      const ticket = prepared.owner.request(input);
      ticket.cancel();
      void ticket.result;
    }
    prepared.owner.dispose();
  }
  created.coordinator.dispose();
}

const thisFreeCoordinatorDispose: (
  this: void,
) => void = coordinator.dispose;
const thisFreePrepareOwner: SqlCatalogSearchWorkCoordinator["prepareOwner"] =
  coordinator.prepareOwner;
const thisFreeActivate: SqlCatalogSearchWorkOwner["activate"] =
  owner.activate;
const thisFreeOwnerDispose: (
  this: void,
) => void = owner.dispose;
const thisFreeRequest: (
  this: void,
  input: SqlCatalogSearchWorkInput,
) => SqlCatalogSearchWorkTicket = owner.request;
const thisFreeCancel: (
  this: void,
) => void = ticket.cancel;

const receiverDependentRequest = function (
  this: { readonly active: boolean },
  _input: SqlCatalogSearchWorkInput,
): SqlCatalogSearchWorkTicket {
  void this.active;
  throw new Error("type fixture only");
};
// @ts-expect-error request callbacks cannot depend on a receiver
const invalidRequestReceiver: SqlCatalogSearchWorkOwner["request"] =
  receiverDependentRequest;

const receiverDependentPrepareOwner = function (
  this: { readonly active: boolean },
  _scope: unknown,
  _dialectId: unknown,
  _dialect: unknown,
  _target: SqlCatalogRevisionTarget,
): SqlCatalogSearchWorkOwnerResult {
  void this.active;
  return { reason: "disposed", status: "unavailable" };
};
// @ts-expect-error owner preparation cannot depend on a receiver
const invalidPrepareOwnerReceiver: SqlCatalogSearchWorkCoordinator["prepareOwner"] =
  receiverDependentPrepareOwner;

const receiverDependentActivate = function (
  this: { readonly active: boolean },
): ReturnType<SqlCatalogSearchWorkOwner["activate"]> {
  void this.active;
  return { status: "active" };
};
// @ts-expect-error owner activation cannot depend on a receiver
const invalidActivateReceiver: SqlCatalogSearchWorkOwner["activate"] =
  receiverDependentActivate;

const receiverDependentCancel = function (
  this: { readonly active: boolean },
): void {
  void this.active;
};
// @ts-expect-error cancellation callbacks cannot depend on a receiver
const invalidCancelReceiver: SqlCatalogSearchWorkTicket["cancel"] =
  receiverDependentCancel;

// @ts-expect-error request input is readonly
input.limit = 50;
// @ts-expect-error ticket result ownership is readonly
ticket.result = Promise.resolve({ status: "cancelled" });

const scopeLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error scope belongs to the prepared owner, not a request
  scope: "notebook:other",
};
const providerLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error provider identity belongs to the coordinator
  providerId: "foreign",
};
const providerHandleLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error provider handles belong to the coordinator
  provider: capturedProvider,
};
const epochLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error epochs are captured by the prepared owner
  expectedEpoch: { generation: 1, token: "foreign" },
};
const epochAliasLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error epoch aliases are captured by the prepared owner
  epoch: { generation: 1, token: "foreign" },
};
const dialectLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error dialect identity belongs to the prepared owner
  dialectId: "postgresql",
};
const runtimeLeakingInput: SqlCatalogSearchWorkInput = {
  ...input,
  // @ts-expect-error dialect runtime belongs to the prepared owner
  dialect,
};

const usableOutcome: SqlCatalogSearchWorkOutcome = {
  observation: "baseline",
  response,
  status: "usable",
};
// @ts-expect-error outcomes are readonly
usableOutcome.status = "cancelled";
const extraOutcomeField: SqlCatalogSearchWorkOutcome = {
  // @ts-expect-error outcome variants reject foreign fields
  providerId: "foreign",
  observation: "equal",
  response,
  status: "usable",
};
const unknownOutcomeStatus: SqlCatalogSearchWorkOutcome = {
  // @ts-expect-error outcome status is a closed discriminant
  status: "loading",
};

function consumeOutcome(outcome: SqlCatalogSearchWorkOutcome): void {
  switch (outcome.status) {
    case "usable":
      void outcome.response;
      break;
    case "superseded":
    case "cancelled":
      break;
    case "unavailable":
      switch (outcome.reason) {
        case "disposed":
        case "execution-timeout":
        case "inactive":
        case "invalid-request":
        case "malformed-response":
        case "overloaded":
        case "provider-failed":
        case "queue-timeout":
          break;
        default: {
          const exhaustiveReason: never = outcome.reason;
          void exhaustiveReason;
        }
      }
      break;
    default: {
      const exhaustiveOutcome: never = outcome;
      void exhaustiveOutcome;
    }
  }
}

// @ts-expect-error captured providers are authentic, not structural objects
const foreignCapturedProvider: CapturedSqlRelationCatalogProvider = {};

declare const ownerResult: SqlCatalogSearchWorkOwnerResult;
if (ownerResult.status === "prepared") {
  void ownerResult.owner.request(input).result.then(consumeOutcome);
}

void thisFreeCoordinatorDispose;
void thisFreePrepareOwner;
void thisFreeActivate;
void thisFreeOwnerDispose;
void thisFreeRequest;
void thisFreeCancel;
void invalidPrepareOwnerReceiver;
void invalidActivateReceiver;
void invalidRequestReceiver;
void invalidCancelReceiver;
void scopeLeakingInput;
void providerLeakingInput;
void providerHandleLeakingInput;
void epochLeakingInput;
void epochAliasLeakingInput;
void dialectLeakingInput;
void runtimeLeakingInput;
void extraOutcomeField;
void unknownOutcomeStatus;
void foreignCapturedProvider;
