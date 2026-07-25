import type {
  SqlRevision,
  SqlTextRange,
} from "./types.js";

export type SqlStatementAffinity = "left" | "right";

export type SqlStatementUnterminatedConstruct =
  | "backtick-quoted-identifier"
  | "block-comment"
  | "dollar-quoted-string"
  | "double-quoted-identifier"
  | "double-quoted-string"
  | "single-quoted-string"
  | "triple-double-quoted-string"
  | "triple-single-quoted-string";

export type SqlStatementOpaqueReason =
  | "custom-delimiter"
  | "procedural-block"
  | "resource-limit";

export type SqlStatementLexicalEnd =
  | {
      readonly kind: "normal";
    }
  | {
      readonly construct: SqlStatementUnterminatedConstruct;
      readonly from: number;
      readonly kind: "unterminated";
    };

interface SqlExactStatementBoundaryBase {
  readonly boundaryQuality: "exact";
  readonly endState: SqlStatementLexicalEnd;
  readonly extent: SqlTextRange;
  readonly source: SqlTextRange;
  readonly terminator: SqlTextRange | null;
}

export type SqlExactStatementBoundary =
  SqlExactStatementBoundaryBase & (
    | {
        readonly code: SqlTextRange;
        readonly hasCode: true;
      }
    | {
        readonly code: null;
        readonly hasCode: false;
      }
  );

export interface SqlOpaqueStatementBoundary {
  readonly boundaryQuality: "opaque";
  readonly extent: SqlTextRange;
  readonly reason: SqlStatementOpaqueReason;
}

export type SqlStatementBoundary =
  | SqlExactStatementBoundary
  | SqlOpaqueStatementBoundary;

export interface SqlStatementBoundaryAtRequest {
  readonly affinity: SqlStatementAffinity;
  readonly position: number;
}

export interface SqlStatementBoundaryAtResult {
  readonly boundary: SqlStatementBoundary;
  readonly revision: SqlRevision;
}

export type SqlStatementBoundariesIntersectingRequest = SqlTextRange;

export interface SqlStatementBoundariesIntersectingResult {
  readonly boundaries: readonly SqlStatementBoundary[];
  readonly revision: SqlRevision;
}
