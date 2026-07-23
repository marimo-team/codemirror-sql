import {
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { EditorState, type Extension } from "@codemirror/state";
import { sqlSchemaFacet } from "../schema-facet.js";

/**
 * Shared test helpers and fixtures.
 *
 * These exist so tests can exercise more behavior with less boilerplate: the
 * `CompletionContext` plumbing, schema fixtures, and label extraction are
 * identical across the completion-source suites, so they live here.
 */

/** A small two-table schema used across completion/diagnostic suites. */
export const TEST_SCHEMA: SQLNamespace = {
  users: ["id", "username", "email"],
  orders: [{ label: "order_id", detail: "Order ID", type: "property" }, "total"],
};

/** A one-level nested (catalog.table) schema. */
export const NESTED_SCHEMA: SQLNamespace = {
  mydb: {
    users: ["id", "username"],
  },
};

/** Creates an `EditorState`, optionally installing a schema facet. */
export function createState(doc: string, extensions: Extension[] = []): EditorState {
  return EditorState.create({ doc, extensions });
}

/** Builds a `CompletionContext` positioned within `doc` (defaults to the end). */
export function createCompletionContext(
  doc: string,
  opts: { pos?: number; explicit?: boolean; extensions?: Extension[] } = {},
): CompletionContext {
  const state = createState(doc, opts.extensions);
  const pos = opts.pos ?? doc.length;
  return new CompletionContext(state, pos, opts.explicit ?? false);
}

/** Extracts the option labels from a completion result. */
export function labels(result: CompletionResult | null): string[] {
  return (result?.options ?? []).map((option) => option.label);
}

/**
 * Options accepted by the {@link completeWith} runner.
 *
 * `schema` is passed to the source factory as config; `facetSchema` installs a
 * {@link sqlSchemaFacet} on the state instead (mirroring how the schema can be
 * supplied either explicitly or via the facet).
 */
export interface CompleteOptions {
  schema?: SQLNamespace;
  pos?: number;
  explicit?: boolean;
  facetSchema?: SQLNamespace;
}

/**
 * Wraps a completion-source factory into a reusable `complete(doc, opts)` runner.
 *
 * When only `facetSchema` is provided, the source is created without an explicit
 * schema so it falls back to reading the facet — matching real usage.
 */
export function completeWith(
  factory: (config: { schema?: SQLNamespace }) => CompletionSource,
): (doc: string, opts?: CompleteOptions) => Promise<CompletionResult | null> {
  return async (doc: string, opts: CompleteOptions = {}) => {
    const source = factory(
      opts.schema === undefined && opts.facetSchema !== undefined ? {} : { schema: opts.schema },
    );
    const context = createCompletionContext(doc, {
      pos: opts.pos,
      explicit: opts.explicit,
      extensions: opts.facetSchema !== undefined ? [sqlSchemaFacet.of(opts.facetSchema)] : [],
    });
    return (await source(context)) as CompletionResult | null;
  };
}
