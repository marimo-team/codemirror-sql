import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlTextRange,
} from "./types.js";

export const MAX_QUERY_BINDING_STATEMENT_LENGTH = 16 * 1024;
export const MAX_QUERY_BINDING_BLOCKS = 256;
export const MAX_QUERY_BINDINGS = 1_024;
export const MAX_QUERY_BINDING_SCOPES = 2_048;
export const MAX_QUERY_VISIBILITY_REGIONS = 2_048;
export const MAX_QUERY_BINDING_ISSUES = 256;
export const MAX_QUERY_BINDING_PATH_COMPONENTS = 8;
export const MAX_QUERY_BINDING_IDENTIFIER_LENGTH = 256;

export type SqlQueryBindingCoverage = "complete" | "partial";

export interface SqlQueryBindingCoverageSet {
  readonly queryBlocks: SqlQueryBindingCoverage;
  readonly relationBindings: SqlQueryBindingCoverage;
  readonly visibility: SqlQueryBindingCoverage;
}

export type SqlQueryBindingIssueCode =
  | "ambiguous-alias"
  | "duplicate-alias"
  | "opaque-template-context"
  | "parser-compatibility"
  | "recursive-cte-uncertainty"
  | "resource-limit"
  | "unknown-correlation"
  | "unsupported-clause"
  | "unsupported-relation-source";

export interface SqlQueryBindingIssue {
  readonly code: SqlQueryBindingIssueCode;
  readonly range: SqlTextRange;
}

export type SqlQueryBlockKind = "compound" | "select";

export interface SqlQueryBlock {
  readonly baseScope: number;
  readonly kind: SqlQueryBlockKind;
  readonly parentBlock: number | null;
  readonly range: SqlTextRange;
}

export interface SqlRelationScope {
  readonly addedBinding: number | null;
  readonly parentScope: number | null;
}

export type SqlVisibilityRegionKind =
  | "from-source"
  | "group-by"
  | "having"
  | "join-condition"
  | "limit"
  | "order-by"
  | "other"
  | "qualify"
  | "select-list"
  | "where";

export interface SqlVisibilityRegion {
  readonly block: number;
  readonly kind: SqlVisibilityRegionKind;
  readonly range: SqlTextRange;
  readonly scope: number;
}

export interface SqlNamedRelationSource {
  readonly kind: "named";
  readonly path: SqlIdentifierPath;
}

export interface SqlDerivedRelationSource {
  readonly block: number;
  readonly kind: "derived";
}

export interface SqlCteRelationSource {
  readonly declarationRange: SqlTextRange;
  readonly kind: "cte";
  readonly name: SqlIdentifierComponent;
}

export interface SqlUnknownRelationSource {
  readonly kind: "unknown";
  readonly reason:
    | "opaque-template-context"
    | "unknown-correlation"
    | "unsupported-relation-source";
}

export type SqlRelationBindingSource =
  | SqlCteRelationSource
  | SqlDerivedRelationSource
  | SqlNamedRelationSource
  | SqlUnknownRelationSource;

export interface SqlRelationBindingAlias {
  readonly explicit: boolean;
  readonly name: SqlIdentifierComponent;
  readonly range: SqlTextRange;
}

export interface SqlRelationBinding {
  readonly alias: SqlRelationBindingAlias | null;
  readonly owner: number;
  readonly range: SqlTextRange;
  readonly source: SqlRelationBindingSource;
}

export interface SqlQueryBindingModel {
  readonly blocks: readonly SqlQueryBlock[];
  readonly bindings: readonly SqlRelationBinding[];
  readonly coverage: SqlQueryBindingCoverageSet;
  readonly issues: readonly SqlQueryBindingIssue[];
  readonly regions: readonly SqlVisibilityRegion[];
  readonly scopes: readonly SqlRelationScope[];
  readonly statementRange: SqlTextRange;
}

export type SqlQueryBindingModelErrorCode =
  | "invalid-authority"
  | "invalid-model"
  | "invalid-source"
  | "resource-limit";

const modelErrors = new WeakSet<object>();
const models = new WeakSet<object>();
const modelOrigins = new WeakMap<
  object,
  { readonly authority: object; readonly statementText: string }
>();

export class SqlQueryBindingModelError extends Error {
  readonly code: SqlQueryBindingModelErrorCode;

  constructor(code: SqlQueryBindingModelErrorCode, message: string) {
    super(message);
    this.name = "SqlQueryBindingModelError";
    this.code = code;
    modelErrors.add(this);
  }
}

export function isSqlQueryBindingModelError(
  candidate: unknown,
): candidate is SqlQueryBindingModelError {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    modelErrors.has(candidate)
  );
}

export function isSqlQueryBindingModel(
  candidate: unknown,
): candidate is SqlQueryBindingModel {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    models.has(candidate)
  );
}

export function sqlQueryBindingModelMatches(
  model: unknown,
  statementText: string,
  authority: unknown,
): boolean {
  if (model === null || typeof model !== "object") {
    return false;
  }
  const origin = modelOrigins.get(model);
  return (
    origin !== undefined &&
    origin.authority === authority &&
    origin.statementText === statementText
  );
}

interface FoundProperty {
  readonly found: true;
  readonly value: unknown;
}

interface MissingProperty {
  readonly found: false;
}

type DataProperty = FoundProperty | MissingProperty;

function ownDataProperty(
  value: object,
  key: PropertyKey,
  subject: string,
): DataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { found: false };
  }
  if (!("value" in descriptor)) {
    throw invalid(`${subject}.${String(key)} cannot be an accessor`);
  }
  return { found: true, value: descriptor.value };
}

function requiredProperty(
  value: object,
  key: PropertyKey,
  subject: string,
): unknown {
  const property = ownDataProperty(value, key, subject);
  if (!property.found) {
    throw invalid(`${subject}.${String(key)} is required`);
  }
  return property.value;
}

function objectValue(value: unknown, subject: string): object {
  if (value === null || typeof value !== "object") {
    throw invalid(`${subject} must be an object`);
  }
  return value;
}

function invalid(message: string): SqlQueryBindingModelError {
  return new SqlQueryBindingModelError("invalid-model", message);
}

function resource(message: string): SqlQueryBindingModelError {
  return new SqlQueryBindingModelError("resource-limit", message);
}

function integer(
  value: unknown,
  subject: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= maximum
  ) {
    throw invalid(`${subject} must be an in-bounds non-negative integer`);
  }
  return value;
}

function nullableInteger(
  value: unknown,
  subject: string,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, subject, maximum);
}

function booleanValue(value: unknown, subject: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`${subject} must be a boolean`);
  }
  return value;
}

function enumValue<Value extends string>(
  value: unknown,
  subject: string,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string") {
    throw invalid(`${subject} is not supported`);
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw invalid(`${subject} is not supported`);
  }
  return match;
}

function arrayValues(
  value: unknown,
  subject: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${subject} must be an array`);
  }
  const lengthProperty = ownDataProperty(value, "length", subject);
  if (
    !lengthProperty.found ||
    typeof lengthProperty.value !== "number" ||
    !Number.isSafeInteger(lengthProperty.value) ||
    lengthProperty.value < 0
  ) {
    throw invalid(`${subject} has an invalid length`);
  }
  if (lengthProperty.value > maximum) {
    throw resource(`${subject} exceeds its ${maximum} item limit`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < lengthProperty.value; index += 1) {
    const item = ownDataProperty(value, index, subject);
    if (!item.found) {
      throw invalid(`${subject} cannot contain holes`);
    }
    result.push(item.value);
  }
  return result;
}

function rangeValue(
  value: unknown,
  statementLength: number,
  subject: string,
  allowEmpty = true,
): SqlTextRange {
  const object = objectValue(value, subject);
  const from = integer(
    requiredProperty(object, "from", subject),
    `${subject}.from`,
    statementLength + 1,
  );
  const to = integer(
    requiredProperty(object, "to", subject),
    `${subject}.to`,
    statementLength + 1,
  );
  if (from > to || (!allowEmpty && from === to)) {
    throw invalid(`${subject} must be a valid half-open range`);
  }
  return Object.freeze({ from, to });
}

function rangeContains(
  outer: SqlTextRange,
  inner: SqlTextRange,
): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}

function authenticatedItem<Value>(
  values: readonly Value[],
  index: number,
): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error("Authenticated query binding model invariant was violated");
  }
  return value;
}

function isBlockAncestorOrSelf(
  model: SqlQueryBindingModel,
  ancestor: number,
  block: number,
): boolean {
  let cursor: number | null = block;
  while (cursor !== null) {
    if (cursor === ancestor) {
      return true;
    }
    cursor = authenticatedItem(model.blocks, cursor).parentBlock;
  }
  return false;
}

function validateScopeOwners(
  model: SqlQueryBindingModel,
  scopeIndex: number,
  blockIndex: number,
  includeLocal: boolean,
  subject: string,
): void {
  let cursor: number | null = scopeIndex;
  while (cursor !== null) {
    const scope: SqlRelationScope =
      authenticatedItem<SqlRelationScope>(model.scopes, cursor);
    if (scope.addedBinding !== null) {
      const binding = authenticatedItem(model.bindings, scope.addedBinding);
      const visible =
        isBlockAncestorOrSelf(model, binding.owner, blockIndex) &&
        (includeLocal || binding.owner !== blockIndex);
      if (!visible) {
        throw invalid(`${subject} contains an unrelated relation binding`);
      }
    }
    cursor = scope.parentScope;
  }
}

function wellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function identifierValue(
  value: unknown,
  subject: string,
): SqlIdentifierComponent {
  const object = objectValue(value, subject);
  const text = requiredProperty(object, "value", subject);
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_QUERY_BINDING_IDENTIFIER_LENGTH ||
    !wellFormedString(text)
  ) {
    throw invalid(`${subject}.value must be a bounded well-formed string`);
  }
  return Object.freeze({
    quoted: booleanValue(
      requiredProperty(object, "quoted", subject),
      `${subject}.quoted`,
    ),
    value: text,
  });
}

function pathValue(
  value: unknown,
  subject: string,
): SqlIdentifierPath {
  const input = arrayValues(
    value,
    subject,
    MAX_QUERY_BINDING_PATH_COMPONENTS,
  );
  if (input.length === 0) {
    throw invalid(`${subject} cannot be empty`);
  }
  return Object.freeze(
    input.map((component, index) =>
      identifierValue(component, `${subject}[${index}]`),
    ),
  );
}

const BLOCK_KINDS: readonly SqlQueryBlockKind[] = Object.freeze([
  "compound",
  "select",
]);
const REGION_KINDS: readonly SqlVisibilityRegionKind[] = Object.freeze([
  "from-source",
  "group-by",
  "having",
  "join-condition",
  "limit",
  "order-by",
  "other",
  "qualify",
  "select-list",
  "where",
]);
const ISSUE_CODES: readonly SqlQueryBindingIssueCode[] = Object.freeze([
  "ambiguous-alias",
  "duplicate-alias",
  "opaque-template-context",
  "parser-compatibility",
  "recursive-cte-uncertainty",
  "resource-limit",
  "unknown-correlation",
  "unsupported-clause",
  "unsupported-relation-source",
]);
const UNKNOWN_REASONS: readonly SqlUnknownRelationSource["reason"][] =
  Object.freeze([
  "opaque-template-context",
  "unknown-correlation",
  "unsupported-relation-source",
  ]);

function coverageValue(
  value: unknown,
): SqlQueryBindingCoverageSet {
  const object = objectValue(value, "query binding coverage");
  const read = (key: string): SqlQueryBindingCoverage => {
    const result = enumValue(
      requiredProperty(object, key, "query binding coverage"),
      `query binding coverage.${key}`,
      ["complete", "partial"],
    );
    return result === "complete" ? "complete" : "partial";
  };
  return Object.freeze({
    queryBlocks: read("queryBlocks"),
    relationBindings: read("relationBindings"),
    visibility: read("visibility"),
  });
}

function blockValue(
  value: unknown,
  index: number,
  count: number,
  scopeCount: number,
  statementLength: number,
): SqlQueryBlock {
  const subject = `query block ${index}`;
  const object = objectValue(value, subject);
  const kind = enumValue(
    requiredProperty(object, "kind", subject),
    `${subject}.kind`,
    BLOCK_KINDS,
  );
  const parentBlock = nullableInteger(
    requiredProperty(object, "parentBlock", subject),
    `${subject}.parentBlock`,
    count,
  );
  if (parentBlock !== null && parentBlock >= index) {
    throw invalid(`${subject} parent must precede its child`);
  }
  return Object.freeze({
    baseScope: integer(
      requiredProperty(object, "baseScope", subject),
      `${subject}.baseScope`,
      scopeCount,
    ),
    kind: kind === "compound" ? "compound" : "select",
    parentBlock,
    range: rangeValue(
      requiredProperty(object, "range", subject),
      statementLength,
      `${subject}.range`,
      false,
    ),
  });
}

function scopeValue(
  value: unknown,
  index: number,
  count: number,
  bindingCount: number,
): SqlRelationScope {
  const subject = `relation scope ${index}`;
  const object = objectValue(value, subject);
  const parentScope = nullableInteger(
    requiredProperty(object, "parentScope", subject),
    `${subject}.parentScope`,
    count,
  );
  if (parentScope !== null && parentScope >= index) {
    throw invalid(`${subject} parent must precede its child`);
  }
  return Object.freeze({
    addedBinding: nullableInteger(
      requiredProperty(object, "addedBinding", subject),
      `${subject}.addedBinding`,
      bindingCount,
    ),
    parentScope,
  });
}

function aliasValue(
  value: unknown,
  statementLength: number,
  subject: string,
): SqlRelationBindingAlias | null {
  if (value === null) {
    return null;
  }
  const object = objectValue(value, subject);
  return Object.freeze({
    explicit: booleanValue(
      requiredProperty(object, "explicit", subject),
      `${subject}.explicit`,
    ),
    name: identifierValue(
      requiredProperty(object, "name", subject),
      `${subject}.name`,
    ),
    range: rangeValue(
      requiredProperty(object, "range", subject),
      statementLength,
      `${subject}.range`,
      false,
    ),
  });
}

function sourceValue(
  value: unknown,
  blockCount: number,
  statementLength: number,
  subject: string,
): SqlRelationBindingSource {
  const object = objectValue(value, subject);
  const kind = requiredProperty(object, "kind", subject);
  if (kind === "named") {
    return Object.freeze({
      kind,
      path: pathValue(requiredProperty(object, "path", subject), `${subject}.path`),
    });
  }
  if (kind === "derived") {
    return Object.freeze({
      block: integer(
        requiredProperty(object, "block", subject),
        `${subject}.block`,
        blockCount,
      ),
      kind,
    });
  }
  if (kind === "cte") {
    return Object.freeze({
      declarationRange: rangeValue(
        requiredProperty(object, "declarationRange", subject),
        statementLength,
        `${subject}.declarationRange`,
        false,
      ),
      kind,
      name: identifierValue(
        requiredProperty(object, "name", subject),
        `${subject}.name`,
      ),
    });
  }
  if (kind === "unknown") {
    const reason = enumValue(
      requiredProperty(object, "reason", subject),
      `${subject}.reason`,
      UNKNOWN_REASONS,
    );
    if (reason === "opaque-template-context") {
      return Object.freeze({ kind, reason });
    }
    if (reason === "unknown-correlation") {
      return Object.freeze({ kind, reason });
    }
    return Object.freeze({
      kind,
      reason: "unsupported-relation-source",
    });
  }
  throw invalid(`${subject}.kind is not supported`);
}

function bindingValue(
  value: unknown,
  index: number,
  blockCount: number,
  statementLength: number,
): SqlRelationBinding {
  const subject = `relation binding ${index}`;
  const object = objectValue(value, subject);
  const range = rangeValue(
    requiredProperty(object, "range", subject),
    statementLength,
    `${subject}.range`,
    false,
  );
  const alias = aliasValue(
    requiredProperty(object, "alias", subject),
    statementLength,
    `${subject}.alias`,
  );
  if (alias !== null && !rangeContains(range, alias.range)) {
    throw invalid(`${subject} must contain its alias range`);
  }
  return Object.freeze({
    alias,
    owner: integer(
      requiredProperty(object, "owner", subject),
      `${subject}.owner`,
      blockCount,
    ),
    range,
    source: sourceValue(
      requiredProperty(object, "source", subject),
      blockCount,
      statementLength,
      `${subject}.source`,
    ),
  });
}

function regionValue(
  value: unknown,
  index: number,
  blockCount: number,
  scopeCount: number,
  statementLength: number,
): SqlVisibilityRegion {
  const subject = `visibility region ${index}`;
  const object = objectValue(value, subject);
  const kind = enumValue(
    requiredProperty(object, "kind", subject),
    `${subject}.kind`,
    REGION_KINDS,
  );
  return Object.freeze({
    block: integer(
      requiredProperty(object, "block", subject),
      `${subject}.block`,
      blockCount,
    ),
    kind,
    range: rangeValue(
      requiredProperty(object, "range", subject),
      statementLength,
      `${subject}.range`,
      false,
    ),
    scope: integer(
      requiredProperty(object, "scope", subject),
      `${subject}.scope`,
      scopeCount,
    ),
  });
}

function issueValue(
  value: unknown,
  index: number,
  statementLength: number,
): SqlQueryBindingIssue {
  const subject = `query binding issue ${index}`;
  const object = objectValue(value, subject);
  const code = enumValue(
    requiredProperty(object, "code", subject),
    `${subject}.code`,
    ISSUE_CODES,
  );
  return Object.freeze({
    code,
    range: rangeValue(
      requiredProperty(object, "range", subject),
      statementLength,
      `${subject}.range`,
    ),
  });
}

function validateRelationships(model: SqlQueryBindingModel): void {
  for (let index = 0; index < model.blocks.length; index += 1) {
    const block = authenticatedItem(model.blocks, index);
    if (block.parentBlock !== null) {
      const parent = authenticatedItem(model.blocks, block.parentBlock);
      if (!rangeContains(parent.range, block.range)) {
        throw invalid(`query block ${index} is outside its parent`);
      }
    }
    validateScopeOwners(
      model,
      block.baseScope,
      index,
      false,
      `query block ${index} base scope`,
    );
    for (let sibling = 0; sibling < index; sibling += 1) {
      const other = authenticatedItem(model.blocks, sibling);
      const overlaps =
        block.range.from < other.range.to &&
        other.range.from < block.range.to;
      if (
        overlaps &&
        !isBlockAncestorOrSelf(model, sibling, index) &&
        !isBlockAncestorOrSelf(model, index, sibling)
      ) {
        throw invalid(`query block ${index} overlaps an unrelated block`);
      }
    }
  }
  for (let index = 0; index < model.bindings.length; index += 1) {
    const binding = authenticatedItem(model.bindings, index);
    const owner = authenticatedItem(model.blocks, binding.owner);
    if (!rangeContains(owner.range, binding.range)) {
      throw invalid(`relation binding ${index} is outside its owner`);
    }
    if (binding.source.kind === "derived") {
      const derived = authenticatedItem(model.blocks, binding.source.block);
      if (derived.parentBlock !== binding.owner) {
        throw invalid(`derived relation binding ${index} has an unrelated block`);
      }
    }
    if (
      model.coverage.relationBindings === "complete" &&
      binding.source.kind === "unknown"
    ) {
      throw invalid("complete relation coverage cannot contain unknown bindings");
    }
  }
  const introducedBindings = new Set<number>();
  for (let index = 0; index < model.scopes.length; index += 1) {
    const scope = authenticatedItem(model.scopes, index);
    if (scope.addedBinding !== null) {
      if (introducedBindings.has(scope.addedBinding)) {
        throw invalid(`relation binding ${scope.addedBinding} is introduced twice`);
      }
      introducedBindings.add(scope.addedBinding);
    }
  }
  if (introducedBindings.size !== model.bindings.length) {
    throw invalid("every relation binding must be introduced by exactly one scope");
  }
  let previousEnd = 0;
  for (let index = 0; index < model.regions.length; index += 1) {
    const region = authenticatedItem(model.regions, index);
    if (region.range.from < previousEnd) {
      throw invalid("visibility regions must be ordered and non-overlapping");
    }
    const block = authenticatedItem(model.blocks, region.block);
    if (!rangeContains(block.range, region.range)) {
      throw invalid(`visibility region ${index} is outside its block`);
    }
    validateScopeOwners(
      model,
      region.scope,
      region.block,
      true,
      `visibility region ${index} scope`,
    );
    previousEnd = region.range.to;
  }
}

export function createSqlQueryBindingModel(
  statementText: unknown,
  authority: unknown,
  input: unknown,
): SqlQueryBindingModel {
  if (typeof statementText !== "string") {
    throw new SqlQueryBindingModelError(
      "invalid-source",
      "query binding statement text must be a string",
    );
  }
  if (
    statementText.length === 0 ||
    statementText.length > MAX_QUERY_BINDING_STATEMENT_LENGTH
  ) {
    throw new SqlQueryBindingModelError(
      statementText.length > MAX_QUERY_BINDING_STATEMENT_LENGTH
        ? "resource-limit"
        : "invalid-source",
      `query binding statement must contain 1-${MAX_QUERY_BINDING_STATEMENT_LENGTH} UTF-16 code units`,
    );
  }
  if (authority === null || typeof authority !== "object") {
    throw new SqlQueryBindingModelError(
      "invalid-authority",
      "query binding parser authority must be an object identity",
    );
  }
  try {
    const object = objectValue(input, "query binding model");
    const blockInputs = arrayValues(
      requiredProperty(object, "blocks", "query binding model"),
      "query blocks",
      MAX_QUERY_BINDING_BLOCKS,
    );
    const bindingInputs = arrayValues(
      requiredProperty(object, "bindings", "query binding model"),
      "relation bindings",
      MAX_QUERY_BINDINGS,
    );
    const scopeInputs = arrayValues(
      requiredProperty(object, "scopes", "query binding model"),
      "relation scopes",
      MAX_QUERY_BINDING_SCOPES,
    );
    const regionInputs = arrayValues(
      requiredProperty(object, "regions", "query binding model"),
      "visibility regions",
      MAX_QUERY_VISIBILITY_REGIONS,
    );
    const issueInputs = arrayValues(
      requiredProperty(object, "issues", "query binding model"),
      "query binding issues",
      MAX_QUERY_BINDING_ISSUES,
    );
    if (blockInputs.length === 0 || scopeInputs.length === 0) {
      throw invalid("query binding model requires a block and a scope");
    }
    const statementRange = rangeValue(
      requiredProperty(object, "statementRange", "query binding model"),
      statementText.length,
      "query binding model.statementRange",
      false,
    );
    if (statementRange.from !== 0 || statementRange.to !== statementText.length) {
      throw invalid("statementRange must cover the exact statement text");
    }
    const blocks = Object.freeze(
      blockInputs.map((block, index) =>
        blockValue(
          block,
          index,
          blockInputs.length,
          scopeInputs.length,
          statementText.length,
        ),
      ),
    );
    const bindings = Object.freeze(
      bindingInputs.map((binding, index) =>
        bindingValue(
          binding,
          index,
          blockInputs.length,
          statementText.length,
        ),
      ),
    );
    const scopes = Object.freeze(
      scopeInputs.map((scope, index) =>
        scopeValue(
          scope,
          index,
          scopeInputs.length,
          bindingInputs.length,
        ),
      ),
    );
    const regions = Object.freeze(
      regionInputs.map((region, index) =>
        regionValue(
          region,
          index,
          blockInputs.length,
          scopeInputs.length,
          statementText.length,
        ),
      ),
    );
    const issues = Object.freeze(
      issueInputs.map((issue, index) =>
        issueValue(issue, index, statementText.length),
      ),
    );
    const model: SqlQueryBindingModel = Object.freeze({
      blocks,
      bindings,
      coverage: coverageValue(
        requiredProperty(object, "coverage", "query binding model"),
      ),
      issues,
      regions,
      scopes,
      statementRange,
    });
    validateRelationships(model);
    models.add(model);
    modelOrigins.set(model, Object.freeze({ authority, statementText }));
    return model;
  } catch (error) {
    if (isSqlQueryBindingModelError(error)) {
      throw error;
    }
    throw new SqlQueryBindingModelError(
      "invalid-model",
      "query binding model could not be inspected safely",
    );
  }
}

export interface SqlVisibleRelationBindings {
  readonly bindings: readonly SqlRelationBinding[];
  readonly coverage: SqlQueryBindingCoverage;
  readonly issues: readonly SqlQueryBindingIssue[];
  readonly region: SqlVisibilityRegion;
  readonly status: "ready";
}

export interface SqlVisibleRelationBindingsUnavailable {
  readonly reason: "invalid-model" | "outside-visibility-region";
  readonly status: "unavailable";
}

export type SqlVisibleRelationBindingsResult =
  | SqlVisibleRelationBindings
  | SqlVisibleRelationBindingsUnavailable;

function regionAt(
  regions: readonly SqlVisibilityRegion[],
  position: number,
): SqlVisibilityRegion | null {
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const region = regions[middle];
    if (!region || region.range.from > position) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const candidate = regions[low - 1];
  return candidate && position < candidate.range.to ? candidate : null;
}

export function visibleSqlRelationBindingsAt(
  model: unknown,
  position: number,
): SqlVisibleRelationBindingsResult {
  if (
    !isSqlQueryBindingModel(model) ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > model.statementRange.to
  ) {
    return Object.freeze({ reason: "invalid-model", status: "unavailable" });
  }
  const region = regionAt(model.regions, position);
  if (region === null) {
    return Object.freeze({
      reason: "outside-visibility-region",
      status: "unavailable",
    });
  }
  const reversed: SqlRelationBinding[] = [];
  let cursor: number | null = region.scope;
  while (cursor !== null) {
    const scope: SqlRelationScope =
      authenticatedItem<SqlRelationScope>(model.scopes, cursor);
    if (scope.addedBinding !== null) {
      const binding = authenticatedItem(model.bindings, scope.addedBinding);
      reversed.push(binding);
    }
    cursor = scope.parentScope;
  }
  reversed.reverse();
  const coverage =
    model.coverage.relationBindings === "complete" &&
    model.coverage.visibility === "complete"
      ? "complete"
      : "partial";
  return Object.freeze({
    bindings: Object.freeze(reversed),
    coverage,
    issues: model.issues,
    region,
    status: "ready",
  });
}

export type SqlIdentifierComparator = (
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
) => boolean;

export interface SqlQualifierResolutionFound {
  readonly binding: SqlRelationBinding;
  readonly coverage: SqlQueryBindingCoverage;
  readonly status: "resolved";
}

export interface SqlQualifierResolutionAmbiguous {
  readonly bindings: readonly SqlRelationBinding[];
  readonly coverage: SqlQueryBindingCoverage;
  readonly status: "ambiguous";
}

export interface SqlQualifierResolutionMissing {
  readonly status: "no-match";
}

export interface SqlQualifierResolutionUnavailable {
  readonly reason:
    | "invalid-model"
    | "outside-visibility-region"
    | "partial-coverage";
  readonly status: "unavailable";
}

export type SqlQualifierResolution =
  | SqlQualifierResolutionAmbiguous
  | SqlQualifierResolutionFound
  | SqlQualifierResolutionMissing
  | SqlQualifierResolutionUnavailable;

function bindingVisibleName(
  binding: SqlRelationBinding,
): SqlIdentifierComponent | null {
  if (binding.alias !== null) {
    return binding.alias.name;
  }
  if (binding.source.kind === "named") {
    return binding.source.path[binding.source.path.length - 1] ?? null;
  }
  if (binding.source.kind === "cte") {
    return binding.source.name;
  }
  return null;
}

export function resolveSqlRelationQualifier(
  model: unknown,
  position: number,
  qualifier: SqlIdentifierComponent,
  equals: SqlIdentifierComparator,
): SqlQualifierResolution {
  const visible = visibleSqlRelationBindingsAt(model, position);
  if (visible.status === "unavailable") {
    return visible;
  }
  const matches: SqlRelationBinding[] = [];
  for (const binding of visible.bindings) {
    const name = bindingVisibleName(binding);
    if (name !== null && equals(name, qualifier)) {
      matches.push(binding);
    }
  }
  if (matches.length === 0) {
    return visible.coverage === "complete"
      ? Object.freeze({ status: "no-match" })
      : Object.freeze({
          reason: "partial-coverage",
          status: "unavailable",
        });
  }
  if (matches.length === 1) {
    const binding = authenticatedItem(matches, 0);
    return Object.freeze({
      binding,
      coverage: visible.coverage,
      status: "resolved",
    });
  }
  return Object.freeze({
    bindings: Object.freeze(matches),
    coverage: visible.coverage,
    status: "ambiguous",
  });
}
