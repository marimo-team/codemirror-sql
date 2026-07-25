import {
  BoundedSqlLexer,
  type BoundedSqlLexeme as Lexeme,
  type BoundedSqlLexerResource,
} from "./bounded-sql-lexer.js";
import type { SqlLexicalProfile } from "./lexical.js";
import type { SqlSourceSnapshot } from "./source.js";
import type { ExactSqlStatementSlot } from "./statement-index.js";
import type { SqlIdentifierComponent } from "./types.js";

const cteRangeBrand: unique symbol = Symbol("SqlCteRange");

export const MAX_CTE_STATEMENT_LENGTH = 65_536;
export const MAX_CTE_DEPTH = 128;
export const MAX_CTE_DECLARATIONS = 256;
export const MAX_CTE_FRAMES = 256;
export const MAX_CTE_IDENTIFIER_LENGTH = 256;

export interface SqlCteRange {
  readonly [cteRangeBrand]: "SqlCteRange";
  readonly from: number;
  readonly to: number;
}

export type SqlCteLayoutIssue =
  | "ambiguous-cte-header"
  | "duplicate-cte-name"
  | "opaque-template-context"
  | "recursive-cte-position"
  | "unknown-cte-identifier-equivalence"
  | "unsupported-cte-extension";

export type SqlCteLayoutResource =
  | "active-statement"
  | "cte-declaration"
  | "cte-frame"
  | "identifier-segment"
  | "lexical-token"
  | "parenthesis-depth";

export interface SqlCteIdentifier {
  readonly component: SqlIdentifierComponent;
}

export type SqlCteIdentifierResult =
  | {
      readonly status: "identifier";
      readonly value: SqlCteIdentifier;
    }
  | {
      readonly status: "unsupported";
    };

export interface SqlCteGrammar {
  readonly declaredColumns: boolean;
  readonly materialization: boolean;
  readonly maximumDeclarationsPerFrame: number;
  readonly recursive: boolean;
}

export interface SqlCteLayoutDialect {
  readonly classifyIdentifierToken: (
    rawIdentifier: string,
    quoted: boolean,
    role: "cte-column" | "cte-name",
  ) => SqlCteIdentifierResult;
  readonly compareCteIdentifiers: (
    left: SqlIdentifierComponent,
    right: SqlIdentifierComponent,
  ) => "distinct" | "equal" | "unknown";
  readonly grammar: SqlCteGrammar;
  readonly lexicalProfile: SqlLexicalProfile;
}

export interface SqlCteDeclaration {
  readonly ambiguous: boolean;
  readonly bodyRange: SqlCteRange;
  readonly equivalenceClass: number;
  readonly frameIndex: number;
  readonly name: SqlIdentifierComponent;
  readonly nameRange: SqlCteRange;
  readonly ordinal: number;
  readonly sourceSpelling: string;
  readonly unknownEquivalenceClasses: readonly number[];
}

export interface SqlCteDraftDeclaration {
  readonly ambiguous: boolean;
  readonly bodyRange: SqlCteRange;
  readonly equivalenceClass: number;
  readonly frameIndex: number;
  readonly name: SqlIdentifierComponent;
  readonly nameRange: SqlCteRange;
  readonly ordinal: number;
  readonly sourceSpelling: string;
  readonly unknownEquivalenceClasses: readonly number[];
}

export interface SqlCteFrame {
  readonly baseDepth: number;
  readonly declarationIndexes: readonly number[];
  readonly issues: readonly SqlCteLayoutIssue[];
  readonly mainQueryStart: number | null;
  readonly parentFrameIndex: number | null;
  readonly recursive: boolean;
  readonly scopeRange: SqlCteRange;
  readonly withStart: number;
}

export interface SqlCteMainQueryEntrypoint {
  readonly depth: number;
  readonly frameIndex: number;
  readonly from: number;
}

interface SqlCteLayoutBase {
  readonly declarations: readonly SqlCteDeclaration[];
  readonly draftDeclarations: readonly SqlCteDraftDeclaration[];
  readonly exactThrough: number;
  readonly frames: readonly SqlCteFrame[];
  readonly issues: readonly SqlCteLayoutIssue[];
  readonly mainQueryEntrypoints: readonly SqlCteMainQueryEntrypoint[];
  readonly statementLength: number;
}

export type SqlCteLayout =
  | (SqlCteLayoutBase & {
      readonly status: "ready";
      readonly issues: readonly [];
    })
  | (SqlCteLayoutBase & {
      readonly status: "partial";
      readonly issues: readonly [
        SqlCteLayoutIssue,
        ...SqlCteLayoutIssue[],
      ];
      readonly resource?: SqlCteLayoutResource;
    })
  | {
      readonly status: "unavailable";
      readonly reason: "opaque-statement" | "resource-limit";
      readonly resource?: SqlCteLayoutResource;
    };

export interface SqlVisibleCte {
  readonly declarationPosition: number;
  readonly name: SqlIdentifierComponent;
  readonly sourceSpelling: string;
}

export type SqlCteShadowing =
  | {
      readonly coverage: "complete";
      readonly names: readonly SqlIdentifierComponent[];
    }
  | {
      readonly coverage: "unknown";
    };

export interface SqlCteVisibility {
  readonly ctes: readonly SqlVisibleCte[];
  readonly issues: readonly SqlCteLayoutIssue[];
  readonly quality: "exact" | "recovered";
  readonly shadowing: SqlCteShadowing;
}

type HeaderState =
  | "after-as"
  | "after-body"
  | "after-name"
  | "columns"
  | "expect-as"
  | "expect-body"
  | "expect-materialized"
  | "expect-name"
  | "main"
  | "modifier-or-name"
  | "waiting-body";

interface DraftDeclaration {
  bodyFrom: number;
  bodyLead: "select" | "with" | null;
  bodyLeadFrameIndex: number | null;
  component: SqlIdentifierComponent;
  nameFrom: number;
  nameTo: number;
  sourceSpelling: string;
}

interface MutableDeclaration {
  ambiguous: boolean;
  bodyFrom: number;
  bodyTo: number;
  identityIndex: number;
  frameIndex: number;
  name: SqlIdentifierComponent;
  nameFrom: number;
  nameTo: number;
  ordinal: number;
  sourceSpelling: string;
}

interface MutableDraftDeclaration {
  ambiguous: boolean;
  bodyFrom: number;
  bodyTo: number;
  identityIndex: number;
  frameIndex: number;
  name: SqlIdentifierComponent;
  nameFrom: number;
  nameTo: number;
  ordinal: number;
  sourceSpelling: string;
}

interface MutableFrame {
  baseDepth: number;
  columnCount: number;
  columnExpectIdentifier: boolean;
  current: DraftDeclaration | null;
  declarationIndexes: number[];
  index: number;
  issues: Set<SqlCteLayoutIssue>;
  mainQueryStart: number | null;
  parentFrameIndex: number | null;
  recursive: boolean;
  scopeFrom: number;
  scopeTo: number | null;
  state: HeaderState;
  withStart: number;
}

interface Builder {
  frame: MutableFrame | null;
  leadingParent: MutableFrame | null;
  withStart: number;
}

interface IdentifierRelations {
  readonly components: SqlIdentifierComponent[];
  readonly frameIndexes: number[];
  readonly unknownIndexes: Map<number, Set<number>>;
  readonly parents: number[];
}

const LEXER_RESOURCES: Readonly<
  Record<BoundedSqlLexerResource, SqlCteLayoutResource>
> = Object.freeze({
  "dollar-quote-delimiter": "identifier-segment",
  "lexical-token": "lexical-token",
});

const missingDataProperty: unique symbol = Symbol(
  "missingDataProperty",
);

function readOwnDataProperty(
  value: unknown,
  key: PropertyKey,
): unknown | typeof missingDataProperty {
  if (value === null || typeof value !== "object") {
    return missingDataProperty;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : missingDataProperty;
}

function createRange(from: number, to: number): SqlCteRange {
  const range: SqlCteRange = {
    [cteRangeBrand]: "SqlCteRange",
    from,
    to,
  };
  return Object.freeze(range);
}

function wordEquals(
  text: string,
  token: Lexeme,
  expected: string,
): boolean {
  if (token.to - token.from !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      (text.charCodeAt(token.from + index) | 32) !==
      expected.charCodeAt(index)
    ) {
      return false;
    }
  }
  return true;
}

function isComment(token: Lexeme): boolean {
  return token.kind === "comment" || token.kind === "line-comment";
}

function isIdentifierToken(token: Lexeme): boolean {
  return token.kind === "word" || token.kind === "quoted-identifier";
}

function punctuation(text: string, token: Lexeme): number {
  return token.kind === "punctuation"
    ? text.charCodeAt(token.from)
    : -1;
}

function freezeComponent(
  component: SqlIdentifierComponent,
): SqlIdentifierComponent {
  return Object.freeze({
    quoted: component.quoted,
    value: component.value,
  });
}

function normalizeIdentifier(
  dialect: SqlCteLayoutDialect,
  text: string,
  token: Lexeme,
  role: "cte-column" | "cte-name",
): SqlCteIdentifier | null {
  if (!token.closed || !isIdentifierToken(token)) {
    return null;
  }
  const raw = text.slice(token.from, token.to);
  const maximumRawLength =
    token.kind === "quoted-identifier"
      ? MAX_CTE_IDENTIFIER_LENGTH * 2 + 2
      : MAX_CTE_IDENTIFIER_LENGTH;
  if (raw.length > maximumRawLength) {
    return null;
  }
  let result: SqlCteIdentifierResult;
  try {
    result = dialect.classifyIdentifierToken(
      raw,
      token.kind === "quoted-identifier",
      role,
    );
    const status = readOwnDataProperty(result, "status");
    if (status !== "identifier") {
      return null;
    }
    const identifier = readOwnDataProperty(result, "value");
    const component = readOwnDataProperty(identifier, "component");
    const componentValue = readOwnDataProperty(component, "value");
    const componentQuoted = readOwnDataProperty(
      component,
      "quoted",
    );
    if (
      typeof componentValue !== "string" ||
      typeof componentQuoted !== "boolean" ||
      componentQuoted !== (token.kind === "quoted-identifier") ||
      componentValue.length === 0 ||
      componentValue.length > MAX_CTE_IDENTIFIER_LENGTH
    ) {
      return null;
    }
    return Object.freeze({
      component: freezeComponent({
        quoted: componentQuoted,
        value: componentValue,
      }),
    });
  } catch {
    return null;
  }
}

function validateDialect(
  dialect: SqlCteLayoutDialect,
): SqlCteLayoutDialect | null {
  try {
    const grammar = readOwnDataProperty(dialect, "grammar");
    const lexicalProfile = readOwnDataProperty(
      dialect,
      "lexicalProfile",
    );
    const classifyIdentifierToken = readOwnDataProperty(
      dialect,
      "classifyIdentifierToken",
    );
    const compareCteIdentifiers = readOwnDataProperty(
      dialect,
      "compareCteIdentifiers",
    );
    const declaredColumns = readOwnDataProperty(
      grammar,
      "declaredColumns",
    );
    const materialization = readOwnDataProperty(
      grammar,
      "materialization",
    );
    const maximumDeclarationsPerFrame = readOwnDataProperty(
      grammar,
      "maximumDeclarationsPerFrame",
    );
    const recursive = readOwnDataProperty(grammar, "recursive");
    const backtickQuotedIdentifiers = readOwnDataProperty(
      lexicalProfile,
      "backtickQuotedIdentifiers",
    );
    const bigQueryStrings = readOwnDataProperty(
      lexicalProfile,
      "bigQueryStrings",
    );
    const dollarQuotedStrings = readOwnDataProperty(
      lexicalProfile,
      "dollarQuotedStrings",
    );
    const hashLineComments = readOwnDataProperty(
      lexicalProfile,
      "hashLineComments",
    );
    const nestedBlockComments = readOwnDataProperty(
      lexicalProfile,
      "nestedBlockComments",
    );
    const proceduralGuards = readOwnDataProperty(
      lexicalProfile,
      "proceduralGuards",
    );
    const singleQuoteBackslash = readOwnDataProperty(
      lexicalProfile,
      "singleQuoteBackslash",
    );
    if (
      typeof classifyIdentifierToken !== "function" ||
      typeof compareCteIdentifiers !== "function" ||
      typeof declaredColumns !== "boolean" ||
      typeof materialization !== "boolean" ||
      typeof recursive !== "boolean" ||
      !Number.isSafeInteger(maximumDeclarationsPerFrame) ||
      (maximumDeclarationsPerFrame as number) < 1 ||
      (maximumDeclarationsPerFrame as number) >
        MAX_CTE_DECLARATIONS ||
      typeof backtickQuotedIdentifiers !== "boolean" ||
      typeof bigQueryStrings !== "boolean" ||
      typeof dollarQuotedStrings !== "boolean" ||
      typeof hashLineComments !== "boolean" ||
      typeof nestedBlockComments !== "boolean" ||
      !["bigquery", "none", "postgresql"].includes(
        proceduralGuards as string,
      ) ||
      !["always", "e-prefix", "never"].includes(
        singleQuoteBackslash as string,
      )
    ) {
      return null;
    }
    return Object.freeze({
      classifyIdentifierToken:
        classifyIdentifierToken as SqlCteLayoutDialect["classifyIdentifierToken"],
      compareCteIdentifiers:
        compareCteIdentifiers as SqlCteLayoutDialect["compareCteIdentifiers"],
      grammar: Object.freeze({
        declaredColumns,
        materialization,
        maximumDeclarationsPerFrame:
          maximumDeclarationsPerFrame as number,
        recursive,
      }),
      lexicalProfile: Object.freeze({
        backtickQuotedIdentifiers,
        bigQueryStrings,
        dollarQuotedStrings,
        hashLineComments,
        nestedBlockComments,
        proceduralGuards:
          proceduralGuards as SqlLexicalProfile["proceduralGuards"],
        singleQuoteBackslash:
          singleQuoteBackslash as SqlLexicalProfile["singleQuoteBackslash"],
      }),
    });
  } catch {
    return null;
  }
}

function relationRoot(
  relations: IdentifierRelations,
  index: number,
): number {
  let root = index;
  while (relations.parents[root] !== root) {
    root = relations.parents[root] ?? root;
  }
  let cursor = index;
  while (relations.parents[cursor] !== root) {
    const parent = relations.parents[cursor] ?? root;
    relations.parents[cursor] = root;
    cursor = parent;
  }
  return root;
}

function compareIdentifiers(
  dialect: SqlCteLayoutDialect,
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): "distinct" | "equal" | "unknown" {
  try {
    const forward = dialect.compareCteIdentifiers(left, right);
    const reverse = dialect.compareCteIdentifiers(right, left);
    return forward === reverse &&
      (forward === "distinct" ||
        forward === "equal" ||
        forward === "unknown")
      ? forward
      : "unknown";
  } catch {
    return "unknown";
  }
}

function isAncestorFrame(
  frames: readonly MutableFrame[],
  possibleAncestor: number,
  descendant: number,
): boolean {
  let cursor: number | null = descendant;
  while (cursor !== null) {
    if (cursor === possibleAncestor) {
      return true;
    }
    cursor = frames[cursor]?.parentFrameIndex ?? null;
  }
  return false;
}

function registerIdentifier(
  dialect: SqlCteLayoutDialect,
  frames: readonly MutableFrame[],
  frame: MutableFrame,
  component: SqlIdentifierComponent,
  relations: IdentifierRelations,
): number {
  const markUnknown = (left: number, right: number): void => {
    frame.issues.add("unknown-cte-identifier-equivalence");
    const leftUnknown =
      relations.unknownIndexes.get(left) ?? new Set();
    leftUnknown.add(right);
    relations.unknownIndexes.set(left, leftUnknown);
    const rightUnknown =
      relations.unknownIndexes.get(right) ?? new Set();
    rightUnknown.add(left);
    relations.unknownIndexes.set(right, rightUnknown);
  };
  const identityIndex = relations.components.length;
  relations.components.push(component);
  relations.frameIndexes.push(frame.index);
  relations.parents.push(identityIndex);
  if (
    compareIdentifiers(dialect, component, component) !== "equal"
  ) {
    markUnknown(identityIndex, identityIndex);
  }
  const comparisonsByRoot = new Map<
    number,
    Map<"distinct" | "equal" | "unknown", number[]>
  >();
  for (let priorIndex = 0; priorIndex < identityIndex; priorIndex += 1) {
    const priorFrameIndex = relations.frameIndexes[priorIndex];
    const priorComponent = relations.components[priorIndex];
    if (
      priorFrameIndex === undefined ||
      !priorComponent ||
      (priorFrameIndex !== frame.index &&
        !isAncestorFrame(
          frames,
          priorFrameIndex,
          frame.index,
        ))
    ) {
      continue;
    }
    const comparison = compareIdentifiers(
      dialect,
      priorComponent,
      component,
    );
    const root = relationRoot(relations, priorIndex);
    const byComparison =
      comparisonsByRoot.get(root) ?? new Map();
    const indexes = byComparison.get(comparison) ?? [];
    indexes.push(priorIndex);
    byComparison.set(comparison, indexes);
    comparisonsByRoot.set(root, byComparison);
  }
  const equalRoots = [...comparisonsByRoot.entries()].filter(
    ([, comparisons]) => comparisons.has("equal"),
  );
  const inconsistent =
    equalRoots.length > 1 ||
    equalRoots.some(([, comparisons]) => comparisons.size > 1);
  for (const [root, comparisons] of comparisonsByRoot) {
    if (inconsistent && comparisons.has("equal")) {
      for (const indexes of comparisons.values()) {
        for (const priorIndex of indexes) {
          markUnknown(identityIndex, priorIndex);
        }
      }
      continue;
    }
    for (const priorIndex of comparisons.get("unknown") ?? []) {
      markUnknown(identityIndex, priorIndex);
    }
    if (comparisons.has("equal")) {
      relations.parents[identityIndex] = root;
    }
  }
  return identityIndex;
}

function freezeIssues(
  issues: Iterable<SqlCteLayoutIssue>,
): readonly SqlCteLayoutIssue[] {
  return Object.freeze([...new Set(issues)].sort());
}

function layoutUnavailable(
  reason: "opaque-statement" | "resource-limit",
  resource?: SqlCteLayoutResource,
): SqlCteLayout {
  return Object.freeze(
    resource === undefined
      ? { reason, status: "unavailable" }
      : { reason, resource, status: "unavailable" },
  );
}

function findOpenParentFrame(
  frames: readonly MutableFrame[],
  depth: number,
): number | null {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (
      frame &&
      frame.baseDepth < depth &&
      frame.scopeTo === null
    ) {
      return frame.index;
    }
  }
  return null;
}

function createFrame(
  frames: MutableFrame[],
  depth: number,
  withStart: number,
  leadingParent: MutableFrame | null,
): MutableFrame {
  const frame: MutableFrame = {
    baseDepth: depth,
    columnCount: 0,
    columnExpectIdentifier: true,
    current: null,
    declarationIndexes: [],
    index: frames.length,
    issues: new Set(),
    mainQueryStart: null,
    parentFrameIndex: findOpenParentFrame(frames, depth),
    recursive: false,
    scopeFrom: withStart,
    scopeTo: null,
    state: "modifier-or-name",
    withStart,
  };
  frames.push(frame);
  if (leadingParent?.current) {
    leadingParent.current.bodyLeadFrameIndex = frame.index;
  }
  return frame;
}

function markPartial(
  frame: MutableFrame | null,
  issues: Set<SqlCteLayoutIssue>,
  issue: SqlCteLayoutIssue,
): void {
  issues.add(issue);
  frame?.issues.add(issue);
}

function processName(
  frame: MutableFrame,
  dialect: SqlCteLayoutDialect,
  text: string,
  token: Lexeme,
  statementFrom: number,
  declarationAttempts: { value: number },
): boolean {
  const identifier = normalizeIdentifier(
    dialect,
    text,
    token,
    "cte-name",
  );
  if (!identifier) {
    return false;
  }
  declarationAttempts.value += 1;
  if (declarationAttempts.value > MAX_CTE_DECLARATIONS) {
    return false;
  }
  frame.current = {
    bodyFrom: -1,
    bodyLead: null,
    bodyLeadFrameIndex: null,
    component: identifier.component,
    nameFrom: token.from - statementFrom,
    nameTo: token.to - statementFrom,
    sourceSpelling: text.slice(token.from, token.to),
  };
  frame.state = "after-name";
  return true;
}

function commitDeclaration(
  frame: MutableFrame,
  current: DraftDeclaration,
  declarations: MutableDeclaration[],
  dialect: SqlCteLayoutDialect,
  frames: readonly MutableFrame[],
  relations: IdentifierRelations,
  bodyTo: number,
): void {
  const declarationIndex = declarations.length;
  const identityIndex = registerIdentifier(
    dialect,
    frames,
    frame,
    current.component,
    relations,
  );
  const declaration: MutableDeclaration = {
    ambiguous: false,
    bodyFrom: current.bodyFrom,
    bodyTo,
    frameIndex: frame.index,
    identityIndex,
    name: current.component,
    nameFrom: current.nameFrom,
    nameTo: current.nameTo,
    ordinal: frame.declarationIndexes.length,
    sourceSpelling: current.sourceSpelling,
  };
  const root = relationRoot(relations, identityIndex);
  for (const priorIndex of frame.declarationIndexes) {
    const priorDeclaration = declarations[priorIndex];
    if (
      priorDeclaration &&
      relationRoot(relations, priorDeclaration.identityIndex) === root
    ) {
      declaration.ambiguous = true;
      priorDeclaration.ambiguous = true;
      frame.issues.add("duplicate-cte-name");
    }
  }
  declarations.push(declaration);
  frame.declarationIndexes.push(declarationIndex);
  frame.current = null;
  frame.state = "after-body";
}

function collectActiveBodyEvidence(
  frames: readonly MutableFrame[],
  declarations: MutableDeclaration[],
  dialect: SqlCteLayoutDialect,
  relations: IdentifierRelations,
  exactThrough: number,
): MutableDraftDeclaration[] {
  const drafts: MutableDraftDeclaration[] = [];
  for (const frame of frames) {
    const current = frame.current;
    if (
      current &&
      current.bodyFrom >= 0 &&
      current.bodyFrom <= exactThrough
    ) {
      const identityIndex = registerIdentifier(
        dialect,
        frames,
        frame,
        current.component,
        relations,
      );
      let ambiguous = false;
      const root = relationRoot(relations, identityIndex);
      for (const priorIndex of frame.declarationIndexes) {
        const priorDeclaration = declarations[priorIndex];
        if (
          priorDeclaration &&
          relationRoot(
            relations,
            priorDeclaration.identityIndex,
          ) === root
        ) {
          ambiguous = true;
          priorDeclaration.ambiguous = true;
          frame.issues.add("duplicate-cte-name");
        }
      }
      drafts.push({
        ambiguous,
        bodyFrom: current.bodyFrom,
        bodyTo: exactThrough,
        frameIndex: frame.index,
        identityIndex,
        name: current.component,
        nameFrom: current.nameFrom,
        nameTo: current.nameTo,
        ordinal: frame.declarationIndexes.length,
        sourceSpelling: current.sourceSpelling,
      });
    }
  }
  return drafts;
}

function closeNestedFrame(
  frames: MutableFrame[],
  builders: Map<number, Builder>,
  depth: number,
  at: number,
  issues: Set<SqlCteLayoutIssue>,
): boolean {
  const builder = builders.get(depth);
  if (!builder) {
    return true;
  }
  if (!builder.frame && frames.length >= MAX_CTE_FRAMES) {
    return false;
  }
  const frame =
    builder.frame ??
    createFrame(
      frames,
      depth,
      builder.withStart,
      builder.leadingParent,
    );
  if (frame.baseDepth !== depth) {
    return true;
  }
  if (!builder.frame) {
    builder.frame = frame;
    markPartial(frame, issues, "ambiguous-cte-header");
  }
  frame.scopeTo = at;
  builders.delete(depth);
  return true;
}

function freezeLayout(
  frames: readonly MutableFrame[],
  declarations: readonly MutableDeclaration[],
  draftDeclarations: readonly MutableDraftDeclaration[],
  relations: IdentifierRelations,
  statementLength: number,
  exactThrough: number,
  issues: Set<SqlCteLayoutIssue>,
  resource?: SqlCteLayoutResource,
): SqlCteLayout {
  const unknownClasses = (identityIndex: number): readonly number[] =>
    Object.freeze(
      [
        ...new Set(
          [...(relations.unknownIndexes.get(identityIndex) ?? [])].map(
            (index) => relationRoot(relations, index),
          ),
        ),
      ].sort((left, right) => left - right),
    );
  const frozenDeclarations = Object.freeze(
    declarations.map((declaration) =>
      Object.freeze({
        ambiguous: declaration.ambiguous,
        bodyRange: createRange(
          declaration.bodyFrom,
          declaration.bodyTo,
        ),
        equivalenceClass: relationRoot(
          relations,
          declaration.identityIndex,
        ),
        frameIndex: declaration.frameIndex,
        name: declaration.name,
        nameRange: createRange(
          declaration.nameFrom,
          declaration.nameTo,
        ),
        ordinal: declaration.ordinal,
        sourceSpelling: declaration.sourceSpelling,
        unknownEquivalenceClasses: unknownClasses(
          declaration.identityIndex,
        ),
      }),
    ),
  );
  const frozenDraftDeclarations = Object.freeze(
    draftDeclarations.map((declaration) =>
      Object.freeze({
        ambiguous: declaration.ambiguous,
        bodyRange: createRange(
          declaration.bodyFrom,
          declaration.bodyTo,
        ),
        equivalenceClass: relationRoot(
          relations,
          declaration.identityIndex,
        ),
        frameIndex: declaration.frameIndex,
        name: declaration.name,
        nameRange: createRange(
          declaration.nameFrom,
          declaration.nameTo,
        ),
        ordinal: declaration.ordinal,
        sourceSpelling: declaration.sourceSpelling,
        unknownEquivalenceClasses: unknownClasses(
          declaration.identityIndex,
        ),
      }),
    ),
  );
  const frozenFrames = Object.freeze(
    frames.map((frame) => {
      const frameIssues = freezeIssues(frame.issues);
      return Object.freeze({
        baseDepth: frame.baseDepth,
        declarationIndexes: Object.freeze([
          ...frame.declarationIndexes,
        ]),
        issues: frameIssues,
        mainQueryStart: frame.mainQueryStart,
        parentFrameIndex: frame.parentFrameIndex,
        recursive: frame.recursive,
        scopeRange: createRange(
          frame.scopeFrom,
          frame.scopeTo ?? exactThrough,
        ),
        withStart: frame.withStart,
      });
    }),
  );
  const mainQueryEntrypoints = Object.freeze(
    frozenFrames
      .map((frame, frameIndex) =>
        frame.mainQueryStart === null
          ? null
          : Object.freeze({
              depth: frame.baseDepth,
              frameIndex,
              from: frame.mainQueryStart,
            }),
      )
      .filter(
        (
          entrypoint,
        ): entrypoint is SqlCteMainQueryEntrypoint =>
          entrypoint !== null,
      )
      .sort((left, right) => left.from - right.from),
  );
  for (const frame of frozenFrames) {
    for (const issue of frame.issues) {
      issues.add(issue);
    }
  }
  const frozenIssues = freezeIssues(issues);
  const base = {
    declarations: frozenDeclarations,
    draftDeclarations: frozenDraftDeclarations,
    exactThrough,
    frames: frozenFrames,
    issues: frozenIssues,
    mainQueryEntrypoints,
    statementLength,
  };
  if (frozenIssues.length === 0 && resource === undefined) {
    const noIssues: readonly [] = Object.freeze([]);
    return Object.freeze({
      ...base,
      issues: noIssues,
      status: "ready",
    });
  }
  const partial = {
    ...base,
    issues: frozenIssues as readonly [
      SqlCteLayoutIssue,
      ...SqlCteLayoutIssue[],
    ],
    status: "partial" as const,
  };
  return Object.freeze(
    resource === undefined ? partial : { ...partial, resource },
  );
}

export function analyzeSqlCteLayout(
  source: SqlSourceSnapshot,
  slot: ExactSqlStatementSlot,
  dialect: SqlCteLayoutDialect,
): SqlCteLayout {
  const statementLength = slot.source.to - slot.source.from;
  if (statementLength > MAX_CTE_STATEMENT_LENGTH) {
    return layoutUnavailable("resource-limit", "active-statement");
  }
  const validatedDialect = validateDialect(dialect);
  if (!validatedDialect) {
    return layoutUnavailable("resource-limit");
  }
  const { grammar, lexicalProfile } = validatedDialect;
  const text = source.analysisText;
  const statementFrom = slot.source.from;
  const lexer = new BoundedSqlLexer(
    source,
    statementFrom,
    slot.source.to,
    lexicalProfile,
  );
  const declarations: MutableDeclaration[] = [];
  const relations: IdentifierRelations = {
    components: [],
    frameIndexes: [],
    unknownIndexes: new Map(),
    parents: [],
  };
  const frames: MutableFrame[] = [];
  const builders = new Map<number, Builder>();
  const bodyOwners = new Map<number, MutableFrame>();
  const columnOwners = new Map<number, MutableFrame>();
  const queryCandidates = new Set<number>([0]);
  const issues = new Set<SqlCteLayoutIssue>();
  const declarationAttempts = { value: 0 };
  let depth = 0;
  let exactThrough = statementLength;
  let resource: SqlCteLayoutResource | undefined;

  scan: while (true) {
    const token = lexer.next();
    if (lexer.resource) {
      exactThrough = Math.max(
        0,
        (lexer.resourceAt ?? statementFrom) - statementFrom,
      );
      resource = LEXER_RESOURCES[lexer.resource];
      issues.add("ambiguous-cte-header");
      break;
    }
    if (!token) {
      break;
    }
    if (isComment(token)) {
      continue;
    }
    if (token.kind === "barrier") {
      exactThrough = token.from - statementFrom;
      issues.add("opaque-template-context");
      for (const frame of frames) {
        if (frame.scopeTo === null) {
          frame.issues.add("opaque-template-context");
        }
      }
      break;
    }
    const code = punctuation(text, token);

    if (code === 41) {
      const columnFrame = columnOwners.get(depth);
      if (columnFrame) {
        if (
          columnFrame.columnExpectIdentifier ||
          columnFrame.columnCount === 0
        ) {
          exactThrough = token.from - statementFrom;
          markPartial(
            columnFrame,
            issues,
            "ambiguous-cte-header",
          );
          break;
        }
        columnFrame.state = "expect-as";
        columnOwners.delete(depth);
        depth -= 1;
        queryCandidates.delete(depth + 1);
        continue;
      }

      if (
        !closeNestedFrame(
          frames,
          builders,
          depth,
          token.from - statementFrom,
          issues,
        )
      ) {
        exactThrough =
          builders.get(depth)?.withStart ??
          token.from - statementFrom;
        resource = "cte-frame";
        issues.add("ambiguous-cte-header");
        break;
      }
      const bodyOwner = bodyOwners.get(depth);
      if (bodyOwner) {
        const current = bodyOwner.current;
        if (
          !current ||
          current.bodyLead === null ||
          (current.bodyLead === "with" &&
            (current.bodyLeadFrameIndex === null ||
              frames[current.bodyLeadFrameIndex]?.mainQueryStart ===
                null))
        ) {
          exactThrough = token.from - statementFrom;
          markPartial(
            bodyOwner,
            issues,
            "ambiguous-cte-header",
          );
          break;
        }
        commitDeclaration(
          bodyOwner,
          current,
          declarations,
          validatedDialect,
          frames,
          relations,
          token.from - statementFrom,
        );
        bodyOwners.delete(depth);
        depth -= 1;
        queryCandidates.delete(depth + 1);
        continue;
      }
      queryCandidates.delete(depth);
      depth = Math.max(0, depth - 1);
      continue;
    }

    const queryCandidate = queryCandidates.has(depth);
    if (queryCandidate && token.kind === "word") {
      if (wordEquals(text, token, "with")) {
        const leadingParent = bodyOwners.get(depth) ?? null;
        builders.set(depth, {
          frame: null,
          leadingParent,
          withStart: token.from - statementFrom,
        });
        if (leadingParent?.current) {
          leadingParent.current.bodyLead = "with";
        }
        queryCandidates.delete(depth);
        continue;
      }
      if (wordEquals(text, token, "select")) {
        const bodyOwner = bodyOwners.get(depth);
        if (bodyOwner?.current) {
          bodyOwner.current.bodyLead = "select";
        }
        queryCandidates.delete(depth);
      } else {
        queryCandidates.delete(depth);
        const bodyOwner = bodyOwners.get(depth);
        if (bodyOwner) {
          exactThrough = token.from - statementFrom;
          markPartial(
            bodyOwner,
            issues,
            "unsupported-cte-extension",
          );
          break;
        }
      }
    } else if (queryCandidate && code !== 40) {
      queryCandidates.delete(depth);
      const bodyOwner = bodyOwners.get(depth);
      if (bodyOwner) {
        exactThrough = token.from - statementFrom;
        markPartial(
          bodyOwner,
          issues,
          "unsupported-cte-extension",
        );
        break;
      }
    }

    const builder = builders.get(depth);
    let frame = builder?.frame ?? null;
    if (builder && !frame) {
      if (frames.length >= MAX_CTE_FRAMES) {
        exactThrough = builder.withStart;
        resource = "cte-frame";
        issues.add("ambiguous-cte-header");
        break;
      }
      frame = createFrame(
        frames,
        depth,
        builder.withStart,
        builder.leadingParent,
      );
      builder.frame = frame;
    }

    if (frame && depth === frame.baseDepth) {
      if (frame.state === "modifier-or-name") {
        if (
          token.kind === "word" &&
          wordEquals(text, token, "recursive")
        ) {
          if (!grammar.recursive) {
            exactThrough = token.from - statementFrom;
            markPartial(
              frame,
              issues,
              "unsupported-cte-extension",
            );
            break;
          }
          frame.recursive = true;
          frame.state = "expect-name";
          continue;
        }
        if (
          !processName(
            frame,
            validatedDialect,
            text,
            token,
            statementFrom,
            declarationAttempts,
          )
        ) {
          exactThrough = token.from - statementFrom;
          if (
            declarationAttempts.value > MAX_CTE_DECLARATIONS
          ) {
            resource = "cte-declaration";
          }
          markPartial(
            frame,
            issues,
            "ambiguous-cte-header",
          );
          break;
        }
        continue;
      }
      if (frame.state === "expect-name") {
        if (
          frame.declarationIndexes.length >=
          grammar.maximumDeclarationsPerFrame
        ) {
          exactThrough = token.from - statementFrom;
          if (
            grammar.maximumDeclarationsPerFrame ===
            MAX_CTE_DECLARATIONS
          ) {
            resource = "cte-declaration";
          }
          markPartial(
            frame,
            issues,
            resource === "cte-declaration"
              ? "ambiguous-cte-header"
              : "unsupported-cte-extension",
          );
          break;
        }
        if (
          !processName(
            frame,
            validatedDialect,
            text,
            token,
            statementFrom,
            declarationAttempts,
          )
        ) {
          exactThrough = token.from - statementFrom;
          if (
            declarationAttempts.value > MAX_CTE_DECLARATIONS
          ) {
            resource = "cte-declaration";
          }
          markPartial(
            frame,
            issues,
            "ambiguous-cte-header",
          );
          break;
        }
        continue;
      }
      if (frame.state === "after-name") {
        if (code === 40) {
          if (!grammar.declaredColumns) {
            exactThrough = token.from - statementFrom;
            markPartial(
              frame,
              issues,
              "unsupported-cte-extension",
            );
            break;
          }
          depth += 1;
          if (depth > MAX_CTE_DEPTH) {
            exactThrough = token.from - statementFrom;
            resource = "parenthesis-depth";
            markPartial(
              frame,
              issues,
              "ambiguous-cte-header",
            );
            break;
          }
          frame.columnCount = 0;
          frame.columnExpectIdentifier = true;
          frame.state = "columns";
          columnOwners.set(depth, frame);
          continue;
        }
        if (
          token.kind === "word" &&
          wordEquals(text, token, "as")
        ) {
          frame.state = "after-as";
          continue;
        }
        exactThrough = token.from - statementFrom;
        markPartial(frame, issues, "ambiguous-cte-header");
        break;
      }
      if (frame.state === "expect-as") {
        if (
          token.kind === "word" &&
          wordEquals(text, token, "as")
        ) {
          frame.state = "after-as";
          continue;
        }
        exactThrough = token.from - statementFrom;
        markPartial(frame, issues, "ambiguous-cte-header");
        break;
      }
      if (frame.state === "after-as") {
        if (
          token.kind === "word" &&
          wordEquals(text, token, "not")
        ) {
          if (!grammar.materialization) {
            exactThrough = token.from - statementFrom;
            markPartial(
              frame,
              issues,
              "unsupported-cte-extension",
            );
            break;
          }
          frame.state = "expect-materialized";
          continue;
        }
        if (
          token.kind === "word" &&
          wordEquals(text, token, "materialized")
        ) {
          if (!grammar.materialization) {
            exactThrough = token.from - statementFrom;
            markPartial(
              frame,
              issues,
              "unsupported-cte-extension",
            );
            break;
          }
          frame.state = "expect-body";
          continue;
        }
        if (code !== 40 || !frame.current) {
          exactThrough = token.from - statementFrom;
          markPartial(frame, issues, "ambiguous-cte-header");
          break;
        }
        depth += 1;
        if (depth > MAX_CTE_DEPTH) {
          exactThrough = token.from - statementFrom;
          resource = "parenthesis-depth";
          markPartial(frame, issues, "ambiguous-cte-header");
          break;
        }
        frame.current.bodyFrom = token.to - statementFrom;
        frame.state = "waiting-body";
        bodyOwners.set(depth, frame);
        queryCandidates.add(depth);
        continue;
      }
      if (frame.state === "expect-body") {
        if (code !== 40 || !frame.current) {
          exactThrough = token.from - statementFrom;
          markPartial(frame, issues, "ambiguous-cte-header");
          break;
        }
        depth += 1;
        if (depth > MAX_CTE_DEPTH) {
          exactThrough = token.from - statementFrom;
          resource = "parenthesis-depth";
          markPartial(frame, issues, "ambiguous-cte-header");
          break;
        }
        frame.current.bodyFrom = token.to - statementFrom;
        frame.state = "waiting-body";
        bodyOwners.set(depth, frame);
        queryCandidates.add(depth);
        continue;
      }
      if (frame.state === "expect-materialized") {
        if (
          token.kind === "word" &&
          wordEquals(text, token, "materialized")
        ) {
          frame.state = "expect-body";
          continue;
        }
        exactThrough = token.from - statementFrom;
        markPartial(frame, issues, "ambiguous-cte-header");
        break;
      }
      if (frame.state === "after-body") {
        if (code === 44) {
          frame.state = "expect-name";
          continue;
        }
        if (
          token.kind === "word" &&
          wordEquals(text, token, "select")
        ) {
          frame.mainQueryStart = token.from - statementFrom;
          frame.state = "main";
          continue;
        }
        exactThrough = token.from - statementFrom;
        markPartial(
          frame,
          issues,
          "unsupported-cte-extension",
        );
        break;
      }
    }

    const columnOwner = columnOwners.get(depth);
    if (columnOwner) {
      if (columnOwner.columnExpectIdentifier) {
        if (
          !normalizeIdentifier(
            validatedDialect,
            text,
            token,
            "cte-column",
          )
        ) {
          exactThrough = token.from - statementFrom;
          markPartial(
            columnOwner,
            issues,
            "ambiguous-cte-header",
          );
          break;
        }
        columnOwner.columnCount += 1;
        columnOwner.columnExpectIdentifier = false;
        continue;
      }
      if (code === 44) {
        columnOwner.columnExpectIdentifier = true;
        continue;
      }
      exactThrough = token.from - statementFrom;
      markPartial(
        columnOwner,
        issues,
        "ambiguous-cte-header",
      );
      break;
    }

    if (code === 40) {
      depth += 1;
      if (depth > MAX_CTE_DEPTH) {
        exactThrough = token.from - statementFrom;
        resource = "parenthesis-depth";
        issues.add("ambiguous-cte-header");
        break scan;
      }
      queryCandidates.add(depth);
    }
  }

  if (exactThrough === statementLength) {
    for (const [builderDepth, builder] of builders) {
      if (!builder.frame) {
        if (frames.length >= MAX_CTE_FRAMES) {
          exactThrough = builder.withStart;
          resource = "cte-frame";
          issues.add("ambiguous-cte-header");
          break;
        }
        builder.frame = createFrame(
          frames,
          builderDepth,
          builder.withStart,
          builder.leadingParent,
        );
      }
    }
  }
  for (const frame of frames) {
    if (frame.scopeTo === null) {
      frame.scopeTo = exactThrough;
    }
    if (
      frame.state !== "main" &&
      exactThrough === statementLength
    ) {
      markPartial(frame, issues, "ambiguous-cte-header");
    }
  }
  const draftDeclarations = collectActiveBodyEvidence(
    frames,
    declarations,
    validatedDialect,
    relations,
    exactThrough,
  );
  return freezeLayout(
    frames,
    declarations,
    draftDeclarations,
    relations,
    statementLength,
    exactThrough,
    issues,
    resource,
  );
}

function framePhase(
  frame: SqlCteFrame,
  frameIndex: number,
  declarations: readonly SqlCteDeclaration[],
  draftDeclarations: readonly SqlCteDraftDeclaration[],
  position: number,
): { readonly kind: "body"; readonly ordinal: number } | {
  readonly kind: "main";
} | null {
  for (const declarationIndex of frame.declarationIndexes) {
    const declaration = declarations[declarationIndex];
    if (
      declaration &&
      declaration.bodyRange.from <= position &&
      position <= declaration.bodyRange.to
    ) {
      return { kind: "body", ordinal: declaration.ordinal };
    }
  }
  for (const declaration of draftDeclarations) {
    if (
      declaration.frameIndex === frameIndex &&
      declaration.bodyRange.from <= position &&
      position <= declaration.bodyRange.to
    ) {
      return { kind: "body", ordinal: declaration.ordinal };
    }
  }
  if (
    frame.mainQueryStart !== null &&
    frame.mainQueryStart <= position
  ) {
    return { kind: "main" };
  }
  return null;
}

export function visibleSqlCtesAt(
  layout: Exclude<SqlCteLayout, { status: "unavailable" }>,
  position: number,
): SqlCteVisibility {
  const namespace = new Map<
    number,
    SqlCteDeclaration | null
  >();
  const shadowNames = new Map<number, SqlIdentifierComponent>();
  const issues = new Set<SqlCteLayoutIssue>();
  const beyondExactCoverage =
    position > layout.exactThrough ||
    (position === layout.exactThrough &&
      layout.exactThrough < layout.statementLength);
  let shadowingUnknown =
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > layout.statementLength ||
    beyondExactCoverage;

  if (beyondExactCoverage) {
    for (const issue of layout.issues) {
      issues.add(issue);
    }
  }
  for (
    let frameIndex = 0;
    frameIndex < layout.frames.length;
    frameIndex += 1
  ) {
    const frame = layout.frames[frameIndex];
    if (!frame) {
      continue;
    }
    if (
      position < frame.scopeRange.from ||
      position > frame.scopeRange.to
    ) {
      continue;
    }
    const phase = framePhase(
      frame,
      frameIndex,
      layout.declarations,
      layout.draftDeclarations,
      position,
    );
    if (!phase) {
      if (
        frame.mainQueryStart === null &&
        frame.issues.length > 0
      ) {
        for (const issue of frame.issues) {
          issues.add(issue);
        }
        shadowingUnknown = true;
      }
      continue;
    }
    for (const issue of frame.issues) {
      issues.add(issue);
      if (issue === "unknown-cte-identifier-equivalence") {
        shadowingUnknown = true;
      }
    }
    const eligibleOrdinal =
      phase.kind === "main"
        ? Number.POSITIVE_INFINITY
        : phase.ordinal;
    const frameDeclarations = frame.declarationIndexes
      .map((index) => layout.declarations[index])
      .filter(
        (declaration): declaration is SqlCteDeclaration =>
          declaration !== undefined,
      );
    const frameDrafts = layout.draftDeclarations.filter(
      (declaration) => declaration.frameIndex === frameIndex,
    );
    for (const declaration of frameDrafts) {
      for (const unknownClass of declaration.unknownEquivalenceClasses) {
        if (namespace.has(unknownClass)) {
          namespace.set(unknownClass, null);
          shadowingUnknown = true;
        }
      }
    }

    if (frame.recursive && phase.kind === "body") {
      issues.add("recursive-cte-position");
      if (frame.mainQueryStart === null) {
        shadowingUnknown = true;
      }
      for (const declaration of frameDeclarations) {
        for (const unknownClass of declaration.unknownEquivalenceClasses) {
          if (namespace.has(unknownClass)) {
            namespace.set(unknownClass, null);
            shadowingUnknown = true;
          }
        }
        namespace.set(declaration.equivalenceClass, null);
        shadowNames.set(
          declaration.equivalenceClass,
          declaration.name,
        );
      }
      for (const declaration of frameDrafts) {
        namespace.set(declaration.equivalenceClass, null);
        shadowNames.set(
          declaration.equivalenceClass,
          declaration.name,
        );
      }
    }

    for (const declaration of frameDeclarations) {
      if (declaration.ordinal >= eligibleOrdinal) {
        continue;
      }
      const key = declaration.equivalenceClass;
      let uncertainCandidate =
        declaration.unknownEquivalenceClasses.includes(key);
      for (const unknownClass of declaration.unknownEquivalenceClasses) {
        if (namespace.has(unknownClass)) {
          namespace.set(unknownClass, null);
          uncertainCandidate = true;
        }
      }
      shadowNames.set(key, declaration.name);
      namespace.set(
        key,
        declaration.ambiguous || uncertainCandidate
          ? null
          : declaration,
      );
    }
  }

  const ctes = Object.freeze(
    [...namespace.values()]
      .filter(
        (declaration): declaration is SqlCteDeclaration =>
          declaration !== null,
      )
      .sort(
        (left, right) =>
          left.nameRange.from - right.nameRange.from,
      )
      .map((declaration) =>
        Object.freeze({
          declarationPosition: declaration.nameRange.from,
          name: declaration.name,
          sourceSpelling: declaration.sourceSpelling,
        }),
      ),
  );
  const frozenIssues = freezeIssues(issues);
  return Object.freeze({
    ctes,
    issues: frozenIssues,
    quality:
      shadowingUnknown || frozenIssues.length > 0
        ? "recovered"
        : "exact",
    shadowing: shadowingUnknown
      ? Object.freeze({ coverage: "unknown" as const })
      : Object.freeze({
          coverage: "complete" as const,
          names: Object.freeze([...shadowNames.values()]),
        }),
  });
}
