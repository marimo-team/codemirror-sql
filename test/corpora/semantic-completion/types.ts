export type SemanticCompletionCategory =
  | "incomplete"
  | "invalid"
  | "multi-statement"
  | "templated"
  | "valid";

export interface SemanticCompletionCase {
  readonly category: SemanticCompletionCategory;
  readonly expectedIncomplete: boolean;
  readonly expectedLabels: readonly string[];
  readonly sql: string;
  readonly template?: string;
}
