import {
  autocompletion,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  selectedCompletion,
  selectedCompletionIndex,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type EditorSelection,
  type Extension,
  type StateEffectType,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type {
  SqlCompletionInfoResolver,
  SqlDisposableCompletionInfo,
} from "./relation-completion-types.js";
import type {
  SqlCompletionItem,
  SqlCompletionRefreshToken,
  SqlCompletionResult,
  SqlCompletionTask,
} from "../relation-completion-types.js";
import type {
  SqlStatementBoundariesIntersectingRequest,
  SqlStatementBoundariesIntersectingResult,
  SqlStatementBoundaryAtRequest,
  SqlStatementBoundaryAtResult,
} from "../statement-boundary-types.js";
import type {
  SqlContextInput,
  SqlDocumentContext,
  SqlDocumentSession,
  SqlEmbeddedRegion,
  SqlLanguageService,
  SqlRevision,
  SqlTextChange,
} from "../types.js";
import {
  createSqlStatementGutter,
  type SqlEditorStatementGutterOptions,
} from "./statement-gutter.js";

export interface SqlEditorAutocompleteOptions {
  readonly activateOnTyping?: boolean;
  readonly activateOnTypingDelay?: number;
  readonly closeOnBlur?: boolean;
  readonly defaultKeymap?: boolean;
  readonly externalSources?: readonly CompletionSource[];
  readonly infoResolver?: SqlCompletionInfoResolver;
  readonly isCompletionPositionAllowed?: (
    state: EditorState,
    position: number,
  ) => boolean;
  readonly maxRenderedOptions?: number;
  readonly selectOnOpen?: boolean;
  readonly updateSyncTime?: number;
}

export interface SqlEditorOptions<
  Context extends SqlDocumentContext,
> {
  readonly autocomplete?: SqlEditorAutocompleteOptions;
  readonly initialContext: SqlContextInput<Context>;
  readonly initialEmbeddedRegions?:
    | readonly SqlEmbeddedRegion[]
    | undefined;
  readonly service: SqlLanguageService<Context>;
  readonly statementGutter?:
    | false
    | SqlEditorStatementGutterOptions;
}

export interface SqlEditorSupport<
  Context extends SqlDocumentContext,
> {
  readonly contextEffect: StateEffectType<SqlContextInput<Context>>;
  readonly embeddedRegionsEffect: StateEffectType<
    readonly SqlEmbeddedRegion[]
  >;
  readonly extension: Extension;
  readonly invalidateCatalog: (view: EditorView) => SqlRevision | null;
  readonly statementBoundariesIntersecting: (
    view: EditorView,
    request: SqlStatementBoundariesIntersectingRequest,
  ) => SqlStatementBoundariesIntersectingResult | null;
  readonly statementBoundaryAt: (
    view: EditorView,
    request: SqlStatementBoundaryAtRequest,
  ) => SqlStatementBoundaryAtResult | null;
  readonly setContext: (
    view: EditorView,
    context: SqlContextInput<Context>,
  ) => void;
  readonly setEmbeddedRegions: (
    view: EditorView,
    regions: readonly SqlEmbeddedRegion[],
  ) => void;
}

export interface SqlEditorRuntime {
  readonly clearTimeout: (
    handle: ReturnType<typeof setTimeout>,
  ) => void;
  readonly closeCompletion: (view: EditorView) => boolean;
  readonly queueMicrotask: (callback: () => void) => void;
  readonly setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly startCompletion: (view: EditorView) => boolean;
}

interface CompletionCapture {
  readonly contextGeneration: number;
  readonly document: Text;
  readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  readonly selection: EditorSelection;
}

interface ActiveCompletion {
  readonly capture: CompletionCapture;
  readonly controller: AbortController;
  readonly sequence: number;
  readonly token: SqlCompletionRefreshToken;
}

interface CompletionIntent {
  readonly capture: CompletionCapture;
  readonly sequence: number;
  readonly token: SqlCompletionRefreshToken;
}

interface ActiveCompletionInfo {
  readonly controller: AbortController;
  disposed: boolean;
  resource: SqlDisposableCompletionInfo | null;
}

const defaultRuntime: SqlEditorRuntime = Object.freeze({
  clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
    clearTimeout(handle),
  closeCompletion,
  queueMicrotask: (callback: () => void) => queueMicrotask(callback),
  setTimeout: (callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs),
  startCompletion,
});

function completionTrigger(): { readonly kind: "invoked" } {
  return { kind: "invoked" };
}

function collectChanges(update: ViewUpdate): readonly SqlTextChange[] {
  const changes: SqlTextChange[] = [];
  update.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    changes.push(Object.freeze({
      from,
      insert: inserted.toString(),
      to,
    }));
  });
  return Object.freeze(changes);
}

function loadingLeaseMs(
  result: Extract<SqlCompletionResult, { readonly status: "ready" }>,
): number | null {
  for (const issue of result.value.issues) {
    if (
      (issue.reason === "catalog-loading" ||
        issue.reason === "column-catalog-loading" ||
        issue.reason === "namespace-catalog-loading") &&
      typeof issue.remainingIntentLeaseMs === "number"
    ) {
      return issue.remainingIntentLeaseMs;
    }
  }
  return null;
}

function haveOneEditRange(items: readonly SqlCompletionItem[]): boolean {
  const first = items[0];
  if (!first) return true;
  for (const item of items) {
    if (
      item.edit.from !== first.edit.from ||
      item.edit.to !== first.edit.to
    ) {
      return false;
    }
  }
  return true;
}

function completionType(item: SqlCompletionItem): string {
  if (item.kind === "column") return "property";
  if (item.kind === "namespace") return "namespace";
  return item.relationKind === "cte" ? "type" : "table";
}

function mapEmbeddedRegions(
  regions: readonly SqlEmbeddedRegion[],
  change: SqlTextChange,
): readonly SqlEmbeddedRegion[] | null {
  const offset =
    change.insert.length - (change.to - change.from);
  const mapped: SqlEmbeddedRegion[] = [];
  for (const region of regions) {
    if (change.to <= region.from) {
      mapped.push(Object.freeze({
        from: region.from + offset,
        language: region.language,
        to: region.to + offset,
      }));
    } else if (change.from >= region.to) {
      mapped.push(region);
    } else {
      return null;
    }
  }
  return Object.freeze(mapped);
}

export function createSqlEditorInternal<
  Context extends SqlDocumentContext,
>(
  options: SqlEditorOptions<Context>,
  runtime: SqlEditorRuntime,
): SqlEditorSupport<Context> {
  const contextEffect =
    StateEffect.define<SqlContextInput<Context>>();
  const embeddedRegionsEffect =
    StateEffect.define<readonly SqlEmbeddedRegion[]>();
  const contextField = StateField.define<SqlContextInput<Context>>({
    create: () => options.initialContext,
    update: (context, transaction) => {
      let next = context;
      for (const effect of transaction.effects) {
        if (effect.is(contextEffect)) next = effect.value;
      }
      return next;
    },
  });
  const embeddedRegionsField = StateField.define<
    readonly SqlEmbeddedRegion[]
  >({
    create: () => options.initialEmbeddedRegions ?? [],
    update: (regions, transaction) => {
      let next = regions;
      for (const effect of transaction.effects) {
        if (effect.is(embeddedRegionsEffect)) next = effect.value;
      }
      return next;
    },
  });
  const autocomplete = options.autocomplete ?? {};
  const {
    externalSources = [],
    infoResolver,
    isCompletionPositionAllowed,
    ...autocompleteOptions
  } = autocomplete;

  let plugin: ViewPlugin<SqlEditorPlugin>;
  let completionSource: CompletionSource;

  class SqlEditorPlugin {
    readonly #view: EditorView;
    readonly #session: SqlDocumentSession<Context>;
    #active: ActiveCompletion | null = null;
    #contextGeneration = 0;
    #destroyed = false;
    #disposingInfo = false;
    #completionPositionAllowed: boolean;
    #hasEmbeddedRegions: boolean;
    #info: ActiveCompletionInfo | null = null;
    #intent: CompletionIntent | null = null;
    #intentTimer: ReturnType<typeof setTimeout> | null = null;
    #lastCompletionStatus: ReturnType<typeof completionStatus>;
    #lastSelectedCompletion: Completion | null;
    #lastSelectedCompletionIndex: number | null;
    #refreshScheduled = false;
    #sequence = 0;
    readonly #subscription;
    readonly #visibilityListener: () => void;

    constructor(view: EditorView) {
      this.#view = view;
      const initialRegions = view.state.field(embeddedRegionsField);
      this.#session = options.service.openDocument({
        context: view.state.field(contextField),
        embeddedRegions: initialRegions,
        text: view.state.doc.toString(),
      });
      this.#hasEmbeddedRegions = initialRegions.length > 0;
      this.#completionPositionAllowed =
        this.#completionPositionIsAllowed(
          view.state,
          view.state.selection.main.head,
        );
      this.#lastCompletionStatus = completionStatus(view.state);
      this.#lastSelectedCompletion = selectedCompletion(view.state);
      this.#lastSelectedCompletionIndex = selectedCompletionIndex(
        view.state,
      );
      this.#subscription = this.#session.onDidChange((event) => {
        if (event.refreshToken === null) {
          this.#clearCompletionState();
          this.#scheduleClose();
          return;
        }
        if (event.refreshToken === this.#active?.token) {
          this.#scheduleRefresh(this.#active.capture);
        } else if (event.refreshToken === this.#intent?.token) {
          this.#scheduleRefresh(this.#intent.capture);
        }
      });
      this.#visibilityListener = () => {
        if (view.dom.ownerDocument.visibilityState === "hidden") {
          this.#clearCompletionState();
        }
      };
      view.dom.ownerDocument.addEventListener(
        "visibilitychange",
        this.#visibilityListener,
      );
    }

    #abortActive(): void {
      this.#active?.controller.abort();
      this.#active = null;
    }

    #disposeInfo(info: ActiveCompletionInfo): void {
      if (info.disposed) return;
      info.disposed = true;
      if (this.#info === info) this.#info = null;
      const resource = info.resource;
      info.resource = null;
      const wasDisposingInfo = this.#disposingInfo;
      this.#disposingInfo = true;
      try {
        try {
          info.controller.abort();
        } catch {
          // Continue to resource cleanup.
        }
        resource?.destroy();
      } catch {
        // Host cleanup must not escape into CodeMirror lifecycle hooks.
      } finally {
        this.#disposingInfo = wasDisposingInfo;
      }
    }

    #clearInfo(): void {
      if (this.#info !== null) this.#disposeInfo(this.#info);
    }

    #clearIntent(): void {
      if (this.#intentTimer !== null) {
        runtime.clearTimeout(this.#intentTimer);
        this.#intentTimer = null;
      }
      this.#intent = null;
    }

    #clearCompletionState(): void {
      this.#sequence += 1;
      this.#abortActive();
      this.#clearInfo();
      this.#clearIntent();
      this.#refreshScheduled = false;
    }

    #captureIsCurrent(capture: CompletionCapture): boolean {
      const state = this.#view.state;
      return (
        !this.#destroyed &&
        capture.contextGeneration === this.#contextGeneration &&
        capture.document === state.doc &&
        capture.embeddedRegions === state.field(embeddedRegionsField) &&
        capture.selection.eq(state.selection)
      );
    }

    #capture(): CompletionCapture {
      const state = this.#view.state;
      return {
        contextGeneration: this.#contextGeneration,
        document: state.doc,
        embeddedRegions: state.field(embeddedRegionsField),
        selection: state.selection,
      };
    }

    #completionPositionIsAllowed(
      state: EditorState,
      position: number,
    ): boolean {
      try {
        return isCompletionPositionAllowed?.(state, position) ?? true;
      } catch {
        return false;
      }
    }

    #scheduleClose(): void {
      const sequence = this.#sequence;
      runtime.queueMicrotask(() => {
        if (
          this.#destroyed ||
          sequence !== this.#sequence
        ) {
          return;
        }
        runtime.closeCompletion(this.#view);
      });
    }

    #scheduleCompletionGateClose(capture: CompletionCapture): void {
      runtime.queueMicrotask(() => {
        if (
          !this.#captureIsCurrent(capture) ||
          this.#completionPositionIsAllowed(
            this.#view.state,
            this.#view.state.selection.main.head,
          )
        ) {
          return;
        }
        runtime.closeCompletion(this.#view);
        if (
          externalSources.length > 0 &&
          this.#captureIsCurrent(capture) &&
          !this.#completionPositionIsAllowed(
            this.#view.state,
            this.#view.state.selection.main.head,
          )
        ) {
          runtime.startCompletion(this.#view);
        }
      });
    }

    #scheduleRefresh(capture: CompletionCapture): void {
      if (
        this.#refreshScheduled ||
        !this.#captureIsCurrent(capture)
      ) {
        return;
      }
      this.#abortActive();
      this.#clearIntent();
      this.#refreshScheduled = true;
      const sequence = ++this.#sequence;
      runtime.queueMicrotask(() => {
        if (
          this.#destroyed ||
          !this.#refreshScheduled ||
          sequence !== this.#sequence ||
          !this.#captureIsCurrent(capture) ||
          (options.autocomplete?.closeOnBlur !== false &&
            !this.#view.hasFocus)
        ) {
          return;
        }
        this.#refreshScheduled = false;
        runtime.startCompletion(this.#view);
      });
    }

    #installIntent(
      token: SqlCompletionRefreshToken,
      capture: CompletionCapture,
      leaseMs: number,
    ): void {
      this.#clearIntent();
      if (leaseMs <= 0 || !this.#captureIsCurrent(capture)) return;
      const sequence = this.#sequence;
      const intent: CompletionIntent = {
        capture,
        sequence,
        token,
      };
      this.#intent = intent;
      this.#intentTimer = runtime.setTimeout(() => {
        if (
          this.#intent === intent &&
          this.#sequence === intent.sequence
        ) {
          this.#intent = null;
          this.#intentTimer = null;
        }
      }, leaseMs);
    }

    #mapCompletion(
      item: SqlCompletionItem,
      revision: SqlRevision,
      capture: CompletionCapture,
    ): Completion {
      const completion: Completion = {
        apply: (view, completion) => {
          const current = view.plugin(plugin);
          if (
            current !== this ||
            !this.#captureIsCurrent(capture) ||
            !this.#session.isCurrent(revision)
          ) {
            return;
          }
          const regions = mapEmbeddedRegions(
            view.state.field(embeddedRegionsField),
            item.edit,
          );
          if (regions === null) return;
          view.dispatch({
            annotations: pickedCompletion.of(completion),
            changes: {
              from: item.edit.from,
              insert: item.edit.insert,
              to: item.edit.to,
            },
            effects: embeddedRegionsEffect.of(regions),
          });
        },
        label: item.label,
        type: completionType(item),
      };
      if (infoResolver !== undefined) {
        completion.info = async () => {
          if (this.#disposingInfo) return null;
          this.#clearInfo();
          if (
            !this.#captureIsCurrent(capture) ||
            !this.#session.isCurrent(revision)
          ) {
            return null;
          }
          const info: ActiveCompletionInfo = {
            controller: new AbortController(),
            disposed: false,
            resource: null,
          };
          this.#info = info;
          let resource: SqlDisposableCompletionInfo | null;
          try {
            resource = await infoResolver(item, {
              signal: info.controller.signal,
            });
          } catch {
            this.#disposeInfo(info);
            return null;
          }
          if (
            info.disposed ||
            this.#info !== info ||
            !this.#captureIsCurrent(capture) ||
            !this.#session.isCurrent(revision)
          ) {
            const wasDisposingInfo = this.#disposingInfo;
            this.#disposingInfo = true;
            try {
              resource?.destroy();
            } catch {
              // Host cleanup must not escape from a stale resolver.
            } finally {
              this.#disposingInfo = wasDisposingInfo;
            }
            return null;
          }
          if (resource === null) {
            this.#disposeInfo(info);
            return null;
          }
          info.resource = resource;
          return {
            dom: resource.dom,
            destroy: () => this.#disposeInfo(info),
          };
        };
      }
      return item.detail === undefined
        ? completion
        : { ...completion, detail: item.detail };
    }

    readonly complete = async (
      context: CompletionContext,
    ): Promise<CompletionResult | null> => {
      this.#clearCompletionState();
      if (
        !this.#completionPositionIsAllowed(
          context.state,
          context.pos,
        )
      ) {
        return null;
      }
      const capture = this.#capture();
      const controller = new AbortController();
      let task: SqlCompletionTask;
      try {
        task = this.#session.complete({
          position: context.pos,
          signal: controller.signal,
          trigger: completionTrigger(),
        });
      } catch {
        this.destroy();
        return null;
      }
      const active: ActiveCompletion = {
        capture,
        controller,
        sequence: this.#sequence,
        token: task.refreshToken,
      };
      this.#active = active;
      context.addEventListener(
        "abort",
        () => {
          controller.abort();
          if (this.#active === active) this.#active = null;
        },
        { onDocChange: true },
      );
      if (context.aborted) controller.abort();

      let result: SqlCompletionResult;
      try {
        result = await task;
      } catch {
        if (
          this.#active === active &&
          active.sequence === this.#sequence &&
          !controller.signal.aborted
        ) {
          this.destroy();
        }
        return null;
      }
      if (
        !this.#completionPositionIsAllowed(
          this.#view.state,
          context.pos,
        )
      ) {
        if (this.#active === active) {
          this.#clearCompletionState();
          this.#scheduleCompletionGateClose(capture);
        }
        return null;
      }
      if (
        controller.signal.aborted ||
        this.#active !== active ||
        active.sequence !== this.#sequence ||
        !this.#captureIsCurrent(capture) ||
        !this.#session.isCurrent(result.revision)
      ) {
        return null;
      }
      this.#active = null;
      if (result.status !== "ready") return null;

      if (!haveOneEditRange(result.value.items)) return null;
      const leaseMs = loadingLeaseMs(result);
      if (result.refreshToken !== null) {
        if (
          result.refreshToken !== active.token ||
          leaseMs === null
        ) {
          return null;
        }
        this.#installIntent(
          result.refreshToken,
          capture,
          leaseMs,
        );
      }
      const first = result.value.items[0];
      if (!first) return null;
      return {
        from: first.edit.from,
        options: result.value.items.map((item) =>
          this.#mapCompletion(item, result.revision, capture)
        ),
        to: first.edit.to,
      };
    };

    readonly cancelCompletion = (): void => {
      this.#clearCompletionState();
    };

    readonly invalidateCatalog = (): SqlRevision | null => {
      if (this.#destroyed) return null;
      try {
        return this.#session.invalidateCatalog();
      } catch {
        return null;
      }
    };

    readonly statementBoundariesIntersecting = (
      request: SqlStatementBoundariesIntersectingRequest,
    ): SqlStatementBoundariesIntersectingResult | null => {
      if (this.#destroyed) return null;
      try {
        return this.#session.statementBoundariesIntersecting(request);
      } catch {
        return null;
      }
    };

    readonly statementBoundaryAt = (
      request: SqlStatementBoundaryAtRequest,
    ): SqlStatementBoundaryAtResult | null => {
      if (this.#destroyed) return null;
      try {
        return this.#session.statementBoundaryAt(request);
      } catch {
        return null;
      }
    };

    readonly update = (update: ViewUpdate): void => {
      const completionPositionAllowed =
        this.#completionPositionIsAllowed(
          update.state,
          update.state.selection.main.head,
        );
      const completionPositionBecameDenied =
        this.#completionPositionAllowed &&
        !completionPositionAllowed;
      this.#completionPositionAllowed = completionPositionAllowed;
      const completionPositionDenied = !completionPositionAllowed;
      if (completionPositionDenied) {
        this.#clearCompletionState();
      }
      let contextChanged = false;
      let regionsChanged = false;
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(contextEffect)) contextChanged = true;
          if (effect.is(embeddedRegionsEffect)) regionsChanged = true;
        }
      }
      if (
        update.docChanged &&
        this.#hasEmbeddedRegions &&
        !regionsChanged
      ) {
        this.destroy();
        throw new Error(
          "SQL document changes with embedded regions require the complete resulting region set",
        );
      }
      if (update.docChanged || contextChanged || regionsChanged) {
        this.#clearCompletionState();
        const regions = regionsChanged
          ? update.state.field(embeddedRegionsField)
          : [];
        const baseRevision = this.#session.revision;
        try {
          if (update.docChanged) {
            const document = {
              changes: collectChanges(update),
              kind: "changes" as const,
            };
            this.#session.update(
              contextChanged
                ? {
                    baseRevision,
                    context: update.state.field(contextField),
                    document,
                    embeddedRegions: regions,
                  }
                : {
                    baseRevision,
                    document,
                    embeddedRegions: regions,
                  },
            );
          } else if (contextChanged) {
            const context = update.state.field(contextField);
            this.#session.update(
              regionsChanged
                ? {
                    baseRevision,
                    context,
                    embeddedRegions: regions,
                  }
                : {
                    baseRevision,
                    context,
                  },
            );
          } else {
            this.#session.update({
              baseRevision,
              embeddedRegions: regions,
            });
          }
        } catch {
          this.destroy();
          return;
        }
        if (contextChanged) this.#contextGeneration += 1;
        if (update.docChanged || regionsChanged) {
          this.#hasEmbeddedRegions = regions.length > 0;
        }
      } else if (update.selectionSet) {
        this.#clearCompletionState();
      }
      if (
        update.focusChanged &&
        !update.view.hasFocus &&
        options.autocomplete?.closeOnBlur !== false
      ) {
        this.#clearCompletionState();
      }
      const nextCompletionStatus = completionStatus(update.state);
      if (
        completionPositionBecameDenied &&
        nextCompletionStatus !== null
      ) {
        this.#scheduleCompletionGateClose(this.#capture());
      }
      const nextSelectedCompletion = selectedCompletion(update.state);
      const nextSelectedCompletionIndex = selectedCompletionIndex(
        update.state,
      );
      if (
        nextSelectedCompletion !== this.#lastSelectedCompletion ||
        nextSelectedCompletionIndex !==
          this.#lastSelectedCompletionIndex
      ) {
        this.#clearInfo();
      }
      this.#lastSelectedCompletion = nextSelectedCompletion;
      this.#lastSelectedCompletionIndex = nextSelectedCompletionIndex;
      if (
        nextCompletionStatus === null &&
        (this.#lastCompletionStatus === "active" ||
          (this.#lastCompletionStatus === "pending" &&
            this.#active !== null))
      ) {
        this.#clearCompletionState();
      }
      this.#lastCompletionStatus = nextCompletionStatus;
    };

    readonly destroy = (): void => {
      if (this.#destroyed) return;
      this.#destroyed = true;
      this.#clearCompletionState();
      this.#view.dom.ownerDocument.removeEventListener(
        "visibilitychange",
        this.#visibilityListener,
      );
      this.#subscription.dispose();
      this.#session.dispose();
    };
  }

  plugin = ViewPlugin.define(
    (view) => new SqlEditorPlugin(view),
  );
  completionSource = (context) => {
    const instance = context.view?.plugin(plugin);
    return instance?.complete(context) ?? null;
  };
  const escapeKeymap = Prec.high(
    keymap.of([{
      key: "Escape",
      run: (view) => {
        view.plugin(plugin)?.cancelCompletion();
        return false;
      },
    }]),
  );
  const statementGutter = options.statementGutter === false ||
      options.statementGutter === undefined
    ? []
    : createSqlStatementGutter(options.statementGutter, {
        boundariesIntersecting: (view, range) =>
          view.plugin(plugin)?.statementBoundariesIntersecting(range) ??
            null,
        boundaryAt: (view, position, affinity) =>
          view.plugin(plugin)?.statementBoundaryAt({
            affinity,
            position,
          }) ?? null,
        inputKeys: (view) => [
          view.state.field(contextField),
          view.state.field(embeddedRegionsField),
        ],
      });
  return Object.freeze({
    contextEffect,
    embeddedRegionsEffect,
    extension: [
      contextField,
      embeddedRegionsField,
      plugin,
      escapeKeymap,
      statementGutter,
      autocompletion({
        ...autocompleteOptions,
        override: [completionSource, ...externalSources],
      }),
    ],
    invalidateCatalog: (view: EditorView): SqlRevision | null =>
      view.plugin(plugin)?.invalidateCatalog() ?? null,
    statementBoundariesIntersecting: (
      view: EditorView,
      request: SqlStatementBoundariesIntersectingRequest,
    ) =>
      view.plugin(plugin)?.statementBoundariesIntersecting(request) ??
        null,
    statementBoundaryAt: (
      view: EditorView,
      request: SqlStatementBoundaryAtRequest,
    ) =>
      view.plugin(plugin)?.statementBoundaryAt(request) ?? null,
    setContext: (
      view: EditorView,
      context: SqlContextInput<Context>,
    ): void => {
      view.dispatch({ effects: contextEffect.of(context) });
    },
    setEmbeddedRegions: (
      view: EditorView,
      regions: readonly SqlEmbeddedRegion[],
    ): void => {
      view.dispatch({
        effects: embeddedRegionsEffect.of(regions),
      });
    },
  });
}

export function sqlEditor<
  Context extends SqlDocumentContext,
>(
  options: SqlEditorOptions<Context>,
): SqlEditorSupport<Context> {
  return createSqlEditorInternal(options, defaultRuntime);
}
