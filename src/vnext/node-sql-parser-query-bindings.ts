import {
  BoundedSqlLexer,
  type BoundedSqlLexeme,
} from "./bounded-sql-lexer.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
} from "./lexical.js";
import {
  createSqlQueryBindingModel,
  MAX_QUERY_BINDING_BLOCKS,
  MAX_QUERY_BINDINGS,
  type SqlQueryBindingIssue,
  type SqlQueryBindingModel,
  type SqlRelationBinding,
  type SqlRelationScope,
  type SqlVisibilityRegion,
} from "./query-binding-model.js";
import { createIdentitySqlSource } from "./source.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlTextRange,
} from "./types.js";

export type NodeSqlParserQueryBindingGrammar =
  | "bigquery"
  | "postgresql";

export interface NodeSqlParserQueryBindingOptions {
  readonly compatibility: boolean;
  readonly grammar: NodeSqlParserQueryBindingGrammar;
}

export type NodeSqlParserQueryBindingResult =
  | {
      readonly model: SqlQueryBindingModel;
      readonly status: "ready";
    }
  | {
      readonly reason:
        | "malformed-ast"
        | "not-query"
        | "resource-limit"
        | "unsupported-shape";
      readonly status: "unavailable";
    };

interface Token extends BoundedSqlLexeme {
  readonly depth: number;
  readonly text: string;
}

interface SelectSkeleton {
  readonly depth: number;
  readonly from: number;
  readonly selectToken: number;
  readonly to: number;
}

interface AstSelect {
  readonly cteChildren: AstSelect[];
  readonly derivedChildren: AstSelect[];
  readonly kind: "compound" | "select";
  readonly node: object;
  skeleton: SelectSkeleton | null;
}

interface RelationSite {
  readonly aliasToken: Token | null;
  readonly derived: boolean;
  readonly explicitAlias: boolean;
  readonly from: number;
  readonly lexicalIdentifiers: readonly SqlIdentifierComponent[];
  readonly to: number;
}

interface BlockBuild {
  readonly ast: AstSelect;
  readonly id: number;
  readonly parent: number | null;
  readonly range: SqlTextRange;
  readonly skeleton: SelectSkeleton;
}

interface MutableCoverage {
  queryBlocks: "complete" | "partial";
  relationBindings: "complete" | "partial";
  visibility: "complete" | "partial";
}

function phaseValue<Value>(
  values: readonly Value[],
  index: number,
): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error("Query binding normalization phase invariant failed");
  }
  return value;
}

function assignedSkeleton(ast: AstSelect): SelectSkeleton {
  if (ast.skeleton === null) {
    throw new Error("Query binding skeleton assignment invariant failed");
  }
  return ast.skeleton;
}

type OwnProperty =
  | { readonly kind: "invalid" | "missing" }
  | { readonly kind: "value"; readonly value: unknown };

const MAX_AST_ARRAY_LENGTH = 1_024;
const MAX_AST_PROPERTY_TEXT = 2_048;

function ownProperty(value: object, key: PropertyKey): OwnProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return { kind: "missing" };
    }
    if (!("value" in descriptor)) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: descriptor.value };
  } catch {
    return { kind: "invalid" };
  }
}

function objectProperty(value: object, key: PropertyKey): object | null {
  const property = ownProperty(value, key);
  return property.kind === "value" &&
    property.value !== null &&
    typeof property.value === "object"
    ? property.value
    : null;
}

function stringProperty(value: object, key: PropertyKey): string | null {
  const property = ownProperty(value, key);
  return property.kind === "value" &&
    typeof property.value === "string" &&
    property.value.length > 0 &&
    property.value.length <= MAX_AST_PROPERTY_TEXT
    ? property.value
    : null;
}

function arrayProperty(
  value: object,
  key: PropertyKey,
): readonly unknown[] | null {
  const property = ownProperty(value, key);
  if (property.kind === "missing") {
    return [];
  }
  if (property.kind !== "value") {
    return null;
  }
  if (property.value === null) {
    return [];
  }
  try {
    if (!Array.isArray(property.value)) {
      return null;
    }
  } catch {
    return null;
  }
  const length = ownProperty(property.value, "length");
  if (
    length.kind !== "value" ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > MAX_AST_ARRAY_LENGTH
  ) {
    return null;
  }
  const items: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const item = ownProperty(property.value, index);
    if (item.kind !== "value") {
      return null;
    }
    items.push(item.value);
  }
  return items;
}

function word(token: Token | undefined, expected: string): boolean {
  return (
    token?.kind === "word" &&
    token.text.toLowerCase() === expected
  );
}

function tokenize(
  text: string,
  grammar: NodeSqlParserQueryBindingGrammar,
): readonly Token[] | null {
  const source = createIdentitySqlSource(text);
  const lexer = new BoundedSqlLexer(
    source,
    0,
    text.length,
    grammar === "bigquery"
      ? BIGQUERY_SQL_LEXICAL_PROFILE
      : POSTGRESQL_SQL_LEXICAL_PROFILE,
  );
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const lexeme = lexer.next();
    if (lexeme === null) {
      return lexer.resource === null ? tokens : null;
    }
    if (
      lexeme.kind === "comment" ||
      lexeme.kind === "line-comment"
    ) {
      continue;
    }
    const raw = text.slice(lexeme.from, lexeme.to);
    if (raw === ")") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    }
    tokens.push(Object.freeze({
      ...lexeme,
      depth,
      text: raw,
    }));
    if (raw === "(") {
      depth += 1;
      if (depth > MAX_QUERY_BINDING_BLOCKS) {
        return null;
      }
    }
  }
}

function selectSkeletons(
  tokens: readonly Token[],
  statementLength: number,
): readonly SelectSkeleton[] {
  const skeletons: SelectSkeleton[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !word(token, "select")) {
      continue;
    }
    let to = statementLength;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (
        candidate?.text === ")" &&
        candidate.depth < token.depth
      ) {
        to = candidate.from;
        break;
      }
    }
    let from = 0;
    if (token.depth > 0) {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = tokens[cursor];
        if (
          candidate?.text !== "(" ||
          candidate.depth !== token.depth - 1
        ) {
          continue;
        }
        const close = matchingClose(tokens, cursor, candidate.depth);
        if (close !== null && phaseValue(tokens, close).from < token.from) {
          continue;
        }
        from = candidate.to;
        break;
      }
    }
    skeletons.push(Object.freeze({
      depth: token.depth,
      from,
      selectToken: index,
      to,
    }));
  }
  return skeletons;
}

function astSelectNode(value: unknown): object | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const type = stringProperty(value, "type");
  return type !== null &&
    (type.toLowerCase() === "select" ||
      type.toLowerCase() === "union" ||
      type.toLowerCase() === "intersect" ||
      type.toLowerCase() === "except")
    ? value
    : null;
}

function astSelectKind(value: object): "compound" | "select" {
  return stringProperty(value, "type")?.toLowerCase() === "select"
    ? "select"
    : "compound";
}

function derivedAst(value: object): object | null {
  const expression = objectProperty(value, "expr");
  if (expression === null) {
    return null;
  }
  return astSelectNode(objectProperty(expression, "ast"));
}

function buildAstTree(
  root: object,
): { readonly root: AstSelect; readonly textual: readonly AstSelect[] } | null {
  const seen = new WeakSet<object>();
  const textual: AstSelect[] = [];
  let count = 0;

  function visit(node: object): AstSelect | null {
    if (seen.has(node) || count >= MAX_QUERY_BINDING_BLOCKS) {
      return null;
    }
    seen.add(node);
    count += 1;
    const result: AstSelect = {
      cteChildren: [],
      derivedChildren: [],
      kind: astSelectKind(node),
      node,
      skeleton: null,
    };
    const withItems = arrayProperty(node, "with");
    if (withItems === null) {
      return null;
    }
    for (const item of withItems) {
      if (item === null || typeof item !== "object") {
        return null;
      }
      const statement = astSelectNode(objectProperty(item, "stmt"));
      if (statement === null) {
        return null;
      }
      const child = visit(statement);
      if (child === null) {
        return null;
      }
      result.cteChildren.push(child);
    }
    textual.push(result);
    const fromItems = arrayProperty(node, "from");
    if (fromItems === null) {
      return null;
    }
    for (const item of fromItems) {
      if (item === null || typeof item !== "object") {
        return null;
      }
      const statement = derivedAst(item);
      if (statement !== null) {
        const child = visit(statement);
        if (child === null) {
          return null;
        }
        result.derivedChildren.push(child);
      }
    }
    return result;
  }

  const tree = visit(root);
  return tree === null ? null : { root: tree, textual };
}

function assignSkeletons(
  tree: { readonly root: AstSelect; readonly textual: readonly AstSelect[] },
  skeletons: readonly SelectSkeleton[],
): boolean {
  if (tree.textual.length > skeletons.length) {
    return false;
  }
  for (let index = 0; index < tree.textual.length; index += 1) {
    const ast = phaseValue(tree.textual, index);
    const skeleton = phaseValue(skeletons, index);
    ast.skeleton = skeleton;
  }
  return true;
}

function emitBlocks(
  root: AstSelect,
  statementLength: number,
): {
  readonly blocks: readonly BlockBuild[];
  readonly ids: ReadonlyMap<object, number>;
} | null {
  const blocks: BlockBuild[] = [];
  const ids = new Map<object, number>();
  function emit(ast: AstSelect, parent: number | null): void {
    const skeleton = assignedSkeleton(ast);
    const id = blocks.length;
    ids.set(ast.node, id);
    blocks.push({
      ast,
      id,
      parent,
      range: Object.freeze(
        parent === null
          ? { from: 0, to: statementLength }
          : { from: skeleton.from, to: skeleton.to },
      ),
      skeleton,
    });
    for (const child of [...ast.cteChildren, ...ast.derivedChildren]) {
      emit(child, id);
    }
  }
  try {
    emit(root, null);
    return { blocks, ids };
  } catch {
    return null;
  }
}

function tokenIdentifier(token: Token): SqlIdentifierComponent | null {
  if (token.kind === "word") {
    return Object.freeze({ quoted: false, value: token.text });
  }
  if (token.kind !== "quoted-identifier" || token.text.length < 2) {
    return null;
  }
  const quote = token.text[0];
  const value = token.text
    .slice(1, -1)
    .split(`${quote}${quote}`)
    .join(quote);
  return value.length === 0
    ? null
    : Object.freeze({ quoted: true, value });
}

function matchingClose(
  tokens: readonly Token[],
  openIndex: number,
  openDepth: number,
): number | null {
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.text === ")" && token.depth === openDepth) {
      return index;
    }
  }
  return null;
}

function relationSites(
  tokens: readonly Token[],
  skeleton: SelectSkeleton,
): readonly RelationSite[] {
  const sites: RelationSite[] = [];
  let inFrom = false;
  for (
    let index = skeleton.selectToken + 1;
    index < tokens.length;
    index += 1
  ) {
    const token = tokens[index];
    if (!token || token.from >= skeleton.to) {
      break;
    }
    if (token.depth !== skeleton.depth) {
      continue;
    }
    const lower = token.kind === "word"
      ? token.text.toLowerCase()
      : "";
    if (
      lower === "where" ||
      lower === "group" ||
      lower === "having" ||
      lower === "qualify" ||
      lower === "order" ||
      lower === "limit" ||
      lower === "window" ||
      lower === "union" ||
      lower === "intersect" ||
      lower === "except"
    ) {
      inFrom = false;
    }
    const startsRelation =
      lower === "from" ||
      lower === "join" ||
      (inFrom && token.text === ",");
    if (!startsRelation) {
      continue;
    }
    inFrom = true;
    const startIndex = index + 1;
    const start = tokens[startIndex];
    if (!start) {
      continue;
    }
    let endIndex = startIndex;
    let derived = false;
    if (start.text === "(") {
      const close = matchingClose(tokens, startIndex, start.depth);
      if (close === null) {
        continue;
      }
      endIndex = close;
      derived = true;
    } else {
      while (endIndex + 2 < tokens.length) {
        const dot = tokens[endIndex + 1];
        const component = tokens[endIndex + 2];
        if (
          dot?.text !== "." ||
          component === undefined ||
          tokenIdentifier(component) === null
        ) {
          break;
        }
        endIndex += 2;
      }
    }
    const lexicalIdentifiers: SqlIdentifierComponent[] = [];
    if (!derived) {
      for (
        let componentIndex = startIndex;
        componentIndex <= endIndex;
        componentIndex += 1
      ) {
        const componentToken = phaseValue(tokens, componentIndex);
        const identifier = tokenIdentifier(componentToken);
        if (identifier !== null) {
          lexicalIdentifiers.push(identifier);
        }
      }
    }
    let aliasToken: Token | null = null;
    let cursor = endIndex + 1;
    const explicitAlias = word(tokens[cursor], "as");
    if (explicitAlias) {
      cursor += 1;
    }
    const possibleAlias = tokens[cursor];
    if (
      possibleAlias !== undefined &&
      possibleAlias.depth === skeleton.depth &&
      tokenIdentifier(possibleAlias) !== null &&
      ![
        "cross", "full", "inner", "join", "left", "natural",
        "on", "right", "using", "where", "group", "having",
        "qualify", "order", "limit", "window",
      ].includes(possibleAlias.text.toLowerCase())
    ) {
      aliasToken = possibleAlias;
      endIndex = cursor;
    }
    const end = phaseValue(tokens, endIndex);
    sites.push(Object.freeze({
      aliasToken,
      derived,
      explicitAlias,
      from: start.from,
      lexicalIdentifiers: Object.freeze(lexicalIdentifiers),
      to: end.to,
    }));
  }
  return sites;
}

function pathFromAst(
  relation: object,
  grammar: NodeSqlParserQueryBindingGrammar,
  site: RelationSite,
): SqlIdentifierPath | null {
  const table = stringProperty(relation, "table");
  if (table === null) {
    return null;
  }
  const values: string[] = [];
  const database =
    stringProperty(relation, "db") ??
    stringProperty(relation, "schema");
  if (database !== null) {
    values.push(database);
  }
  if (grammar === "bigquery") {
    values.push(...table.split("."));
  } else {
    values.push(table);
  }
  if (
    values.length === 0 ||
    values.length > 8 ||
    values.some((value) => value.length === 0 || value.length > 256)
  ) {
    return null;
  }
  const lexicalIdentifiers = site.lexicalIdentifiers;
  const singleQuotedBigQueryPath =
    grammar === "bigquery" &&
    lexicalIdentifiers.length === 1 &&
    lexicalIdentifiers[0]?.quoted === true;
  if (singleQuotedBigQueryPath) {
    if (lexicalIdentifiers[0]?.value !== values.join(".")) {
      return null;
    }
    return Object.freeze(values.map((value) =>
      Object.freeze({ quoted: true, value })
    ));
  }
  if (
    values.length !== lexicalIdentifiers.length ||
    values.some((value, index) => {
      const lexical = lexicalIdentifiers[index];
      return lexical === undefined ||
        !identifierMatchesAst(value, lexical);
    })
  ) {
    return null;
  }
  return Object.freeze([...lexicalIdentifiers]);
}

interface CteDeclaration {
  readonly name: SqlIdentifierComponent;
  readonly range: SqlTextRange;
}

interface IdentifierToken {
  readonly identifier: SqlIdentifierComponent;
  readonly token: Token;
}

function identifierMatchesAst(
  astValue: string,
  lexical: SqlIdentifierComponent,
): boolean {
  return lexical.quoted
    ? astValue === lexical.value
    : astValue.toLowerCase() === lexical.value.toLowerCase();
}

function identifierKey(identifier: SqlIdentifierComponent): string {
  return identifier.quoted
    ? `quoted:${identifier.value}`
    : `unquoted:${identifier.value.toLowerCase()}`;
}

function findIdentifierToken(
  tokens: readonly Token[],
  from: number,
  to: number,
  depth: number,
  astName: string,
): IdentifierToken | null {
  for (const token of tokens) {
    const identifier = tokenIdentifier(token);
    if (
      token.from >= from &&
      token.from < to &&
      token.depth === depth &&
      identifier !== null &&
      identifierMatchesAst(astName, identifier)
    ) {
      return { identifier, token };
    }
  }
  return null;
}

function ownCteDeclarations(
  ast: AstSelect,
  tokens: readonly Token[],
): readonly CteDeclaration[] | null {
  const withItems = arrayProperty(ast.node, "with");
  if (withItems === null) {
    return null;
  }
  if (withItems.length !== ast.cteChildren.length) {
    return null;
  }
  const declarations: CteDeclaration[] = [];
  let searchFrom = assignedSkeleton(ast).from;
  for (let index = 0; index < withItems.length; index += 1) {
    const item = withItems[index];
    const child = phaseValue(ast.cteChildren, index);
    if (item === null || typeof item !== "object") {
      return null;
    }
    const nameObject = objectProperty(item, "name");
    const name = nameObject === null
      ? stringProperty(item, "name")
      : stringProperty(nameObject, "value");
    if (name === null) {
      return null;
    }
    const declaration = findIdentifierToken(
      tokens,
      searchFrom,
      assignedSkeleton(child).from,
      assignedSkeleton(ast).depth,
      name,
    );
    if (declaration === null) {
      return null;
    }
    declarations.push(Object.freeze({
      name: declaration.identifier,
      range: Object.freeze({
        from: declaration.token.from,
        to: declaration.token.to,
      }),
    }));
    searchFrom = assignedSkeleton(child).to;
  }
  return Object.freeze(declarations);
}

function visibleCteDeclarations(
  root: AstSelect,
  tokens: readonly Token[],
): ReadonlyMap<object, ReadonlyMap<string, CteDeclaration>> | null {
  const result = new Map<object, ReadonlyMap<string, CteDeclaration>>();
  function visit(
    ast: AstSelect,
    inherited: ReadonlyMap<string, CteDeclaration>,
  ): boolean {
    const own = ownCteDeclarations(ast, tokens);
    if (own === null) {
      return false;
    }
    const visible = new Map(inherited);
    for (let index = 0; index < ast.cteChildren.length; index += 1) {
      const child = phaseValue(ast.cteChildren, index);
      if (!visit(child, visible)) {
        return false;
      }
      const declaration = phaseValue(own, index);
      visible.set(identifierKey(declaration.name), declaration);
    }
    result.set(ast.node, visible);
    for (const child of ast.derivedChildren) {
      if (!visit(child, visible)) {
        return false;
      }
    }
    return true;
  }
  return visit(root, new Map()) ? result : null;
}

function addIssue(
  issues: SqlQueryBindingIssue[],
  code: SqlQueryBindingIssue["code"],
  range: SqlTextRange,
): void {
  if (
    issues.length < 256 &&
    !issues.some((issue) =>
      issue.code === code &&
      issue.range.from === range.from &&
      issue.range.to === range.to
    )
  ) {
    issues.push(Object.freeze({ code, range }));
  }
}

function clauseRegions(
  tokens: readonly Token[],
  block: BlockBuild,
  fullScope: number,
): SqlVisibilityRegion[] {
  const markers: {
    readonly from: number;
    readonly kind: SqlVisibilityRegion["kind"];
    readonly to: number;
  }[] = [];
  const start = block.skeleton.selectToken;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.from >= block.skeleton.to) {
      break;
    }
    if (token.depth !== block.skeleton.depth || token.kind !== "word") {
      continue;
    }
    const value = token.text.toLowerCase();
    const kind =
      value === "select" ? "select-list"
      : value === "where" ? "where"
      : value === "group" && word(tokens[index + 1], "by") ? "group-by"
      : value === "having" ? "having"
      : value === "qualify" ? "qualify"
      : value === "order" && word(tokens[index + 1], "by") ? "order-by"
      : value === "limit" ? "limit"
      : null;
    if (kind !== null) {
      markers.push({ from: token.from, kind, to: token.to });
    }
  }
  const fromToken = tokens.find((token) =>
    token.depth === block.skeleton.depth &&
    token.from > block.skeleton.from &&
    token.from < block.skeleton.to &&
    word(token, "from")
  );
  const result: SqlVisibilityRegion[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = phaseValue(markers, index);
    const next = markers[index + 1];
    const to =
      marker.kind === "select-list" && fromToken !== undefined
        ? fromToken.from
        : next?.from ?? block.skeleton.to;
    if (marker.to < to) {
      result.push(Object.freeze({
        block: block.id,
        kind: marker.kind,
        range: Object.freeze({ from: marker.to, to }),
        scope: fullScope,
      }));
    }
  }
  return result;
}

function joinRegions(
  tokens: readonly Token[],
  block: BlockBuild,
  sites: readonly RelationSite[],
  scopesAfterRelations: readonly number[],
): SqlVisibilityRegion[] {
  const result: SqlVisibilityRegion[] = [];
  for (let relationIndex = 1; relationIndex < sites.length; relationIndex += 1) {
    const site = phaseValue(sites, relationIndex);
    const scope = scopesAfterRelations[relationIndex];
    if (scope === undefined) {
      continue;
    }
    let conditionIndex = -1;
    for (let index = 0; index < tokens.length; index += 1) {
      const candidate = phaseValue(tokens, index);
      if (
        candidate.from < site.to ||
        candidate.depth !== block.skeleton.depth
      ) {
        continue;
      }
      if (candidate.from >= block.skeleton.to) {
        break;
      }
      if (word(candidate, "on") || word(candidate, "using")) {
        conditionIndex = index;
        break;
      }
      if (
        word(candidate, "join") ||
        candidate.text === "," ||
        word(candidate, "where") ||
        word(candidate, "group") ||
        word(candidate, "having") ||
        word(candidate, "qualify") ||
        word(candidate, "order") ||
        word(candidate, "limit")
      ) {
        break;
      }
    }
    const token = tokens[conditionIndex];
    if (token === undefined) {
      continue;
    }
    let to = block.skeleton.to;
    for (let cursor = conditionIndex + 1; cursor < tokens.length; cursor += 1) {
      const next = phaseValue(tokens, cursor);
      if (next.from >= block.skeleton.to) {
        break;
      }
      if (
        next.depth === block.skeleton.depth &&
        (word(next, "join") ||
          next.text === "," ||
          word(next, "where") ||
          word(next, "group") ||
          word(next, "having") ||
          word(next, "qualify") ||
          word(next, "order") ||
          word(next, "limit"))
      ) {
        to = next.from;
        break;
      }
    }
    if (token.to < to) {
      result.push(Object.freeze({
        block: block.id,
        kind: "join-condition",
        range: Object.freeze({ from: token.to, to }),
        scope,
      }));
    }
  }
  return result;
}

export function normalizeNodeSqlParserQueryBindings(
  root: unknown,
  statementText: unknown,
  authority: unknown,
  options: NodeSqlParserQueryBindingOptions,
): NodeSqlParserQueryBindingResult {
  if (
    typeof statementText !== "string" ||
    statementText.length === 0 ||
    statementText.length > 16 * 1024 ||
    authority === null ||
    typeof authority !== "object"
  ) {
    return Object.freeze({ reason: "resource-limit", status: "unavailable" });
  }
  const astRoot = astSelectNode(root);
  if (astRoot === null) {
    return Object.freeze({ reason: "not-query", status: "unavailable" });
  }
  const tokens = tokenize(statementText, options.grammar);
  if (tokens === null) {
    return Object.freeze({ reason: "resource-limit", status: "unavailable" });
  }
  const skeletons = selectSkeletons(tokens, statementText.length);
  const tree = buildAstTree(astRoot);
  if (tree === null) {
    return Object.freeze({ reason: "malformed-ast", status: "unavailable" });
  }
  if (!assignSkeletons(tree, skeletons)) {
    return Object.freeze({ reason: "unsupported-shape", status: "unavailable" });
  }
  const emitted = emitBlocks(tree.root, statementText.length);
  if (emitted === null) {
    return Object.freeze({ reason: "unsupported-shape", status: "unavailable" });
  }
  const declarations = visibleCteDeclarations(tree.root, tokens);
  if (declarations === null) {
    return Object.freeze({ reason: "malformed-ast", status: "unavailable" });
  }

  const coverage: MutableCoverage = {
    queryBlocks:
      skeletons.length === tree.textual.length ? "complete" : "partial",
    relationBindings: "complete",
    visibility: "complete",
  };
  const issues: SqlQueryBindingIssue[] = [];
  const statementRange = Object.freeze({ from: 0, to: statementText.length });
  if (options.compatibility) {
    coverage.queryBlocks = "partial";
    coverage.relationBindings = "partial";
    coverage.visibility = "partial";
    addIssue(issues, "parser-compatibility", statementRange);
  }
  if (skeletons.length !== tree.textual.length) {
    addIssue(issues, "unsupported-clause", statementRange);
  }

  const bindings: SqlRelationBinding[] = [];
  const scopes: SqlRelationScope[] = [
    Object.freeze({ addedBinding: null, parentScope: null }),
  ];
  const regions: SqlVisibilityRegion[] = [];
  const publicBlocks = emitted.blocks.map((block) =>
    Object.freeze({
      baseScope: 0,
      kind: block.ast.kind,
      parentBlock: block.parent,
      range: block.range,
    }),
  );

  for (const block of emitted.blocks) {
    const fromItems = arrayProperty(block.ast.node, "from");
    if (fromItems === null) {
      return Object.freeze({ reason: "malformed-ast", status: "unavailable" });
    }
    const sites = relationSites(tokens, block.skeleton);
    if (sites.length !== fromItems.length) {
      coverage.relationBindings = "partial";
      coverage.visibility = "partial";
      addIssue(issues, "unsupported-relation-source", block.range);
    }
    let currentScope = 0;
    const after: number[] = [];
    const count = Math.min(sites.length, fromItems.length);
    for (let index = 0; index < count; index += 1) {
      if (bindings.length >= MAX_QUERY_BINDINGS) {
        return Object.freeze({ reason: "resource-limit", status: "unavailable" });
      }
      const rawRelation = fromItems[index];
      const site = phaseValue(sites, index);
      if (
        rawRelation === null ||
        typeof rawRelation !== "object"
      ) {
        return Object.freeze({ reason: "malformed-ast", status: "unavailable" });
      }
      const aliasText = stringProperty(rawRelation, "as");
      const aliasToken = site.aliasToken;
      const aliasName =
        aliasToken === null ? null : tokenIdentifier(aliasToken);
      const aliasMatches =
        aliasText !== null &&
        aliasName !== null &&
        identifierMatchesAst(aliasText, aliasName);
      const alias =
        aliasMatches && aliasName !== null && aliasToken !== null
          ? Object.freeze({
              explicit: site.explicitAlias,
              name: aliasName,
              range: Object.freeze({
                from: aliasToken.from,
                to: aliasToken.to,
              }),
            })
          : null;
      if (
        (aliasText === null) !== (site.aliasToken === null) ||
        (aliasText !== null && aliasName !== null && !aliasMatches)
      ) {
        coverage.relationBindings = "partial";
        addIssue(issues, "unsupported-relation-source", {
          from: site.from,
          to: site.to,
        });
      }
      const nested = derivedAst(rawRelation);
      let source: SqlRelationBinding["source"];
      if (nested !== null) {
        const nestedId = emitted.ids.get(nested);
        if (nestedId === undefined || !site.derived) {
          coverage.relationBindings = "partial";
          source = Object.freeze({
            kind: "unknown",
            reason: "unsupported-relation-source",
          });
        } else {
          source = Object.freeze({ block: nestedId, kind: "derived" });
        }
      } else {
        const path = pathFromAst(
          rawRelation,
          options.grammar,
          site,
        );
        if (path === null || site.derived) {
          coverage.relationBindings = "partial";
          addIssue(issues, "unsupported-relation-source", {
            from: site.from,
            to: site.to,
          });
          source = Object.freeze({
            kind: "unknown",
            reason: "unsupported-relation-source",
          });
        } else {
          const last = phaseValue(path, path.length - 1);
          const blockDeclarations = declarations.get(block.ast.node);
          const declaration = blockDeclarations?.get(identifierKey(last));
          source =
            declaration === undefined
              ? Object.freeze({ kind: "named", path })
              : Object.freeze({
                  declarationRange: declaration.range,
                  kind: "cte",
                  name: declaration.name,
                });
        }
      }
      const bindingIndex = bindings.length;
      bindings.push(Object.freeze({
        alias,
        owner: block.id,
        range: Object.freeze({ from: site.from, to: site.to }),
        source,
      }));
      scopes.push(Object.freeze({
        addedBinding: bindingIndex,
        parentScope: currentScope,
      }));
      if (!site.derived) {
        regions.push(Object.freeze({
          block: block.id,
          kind: "from-source",
          range: Object.freeze({ from: site.from, to: site.to }),
          scope: currentScope,
        }));
      }
      currentScope = scopes.length - 1;
      after.push(currentScope);
    }
    regions.push(...clauseRegions(tokens, block, currentScope));
    regions.push(...joinRegions(tokens, block, sites, after));
  }

  regions.sort((left, right) =>
    left.range.from - right.range.from ||
    left.range.to - right.range.to
  );
  const nonOverlapping: SqlVisibilityRegion[] = [];
  let end = 0;
  for (const region of regions) {
    if (region.range.from < end) {
      coverage.visibility = "partial";
      addIssue(issues, "unsupported-clause", region.range);
      continue;
    }
    nonOverlapping.push(region);
    end = region.range.to;
  }

  try {
    return Object.freeze({
      model: createSqlQueryBindingModel(
        statementText,
        authority,
        {
          bindings,
          blocks: publicBlocks,
          coverage,
          issues,
          regions: nonOverlapping,
          scopes,
          statementRange,
        },
      ),
      status: "ready",
    });
  } catch {
    return Object.freeze({ reason: "unsupported-shape", status: "unavailable" });
  }
}
