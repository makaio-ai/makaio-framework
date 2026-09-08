import type { MakaioBusLike } from '@makaio/core';
import type {
  ArtifactActor,
  ArtifactKindRegistration,
  ArtifactObservation,
  ArtifactRef,
  ArtifactRelation,
  ArtifactRepresentations,
  ArtifactRevision,
  ArtifactScope,
} from './schemas.js';

/**
 * Semantic lifecycle event names used to describe what happened to an artifact
 * after a write operation completes.
 *
 * These are the observable outcomes of artifact mutations and are used by
 * after hooks and other explicit workflow consumers.
 */
export type ArtifactLifecycleSemanticEvent = 'created' | 'revised' | 'status-changed' | 'observation-added';

/**
 * All hook-trigger points in the artifact lifecycle pipeline.
 *
 * - `beforeCreate` / `beforeRevise` — synchronous guards that can reject or
 *   patch the draft before it is persisted.
 * - `afterCreate` / `afterRevise` / `afterStatusChanged` / `afterObservationAdded` —
 *   after hooks that run once a write has succeeded.
 */
export type ArtifactLifecycleHookEvent =
  | 'beforeCreate'
  | 'beforeRevise'
  | 'afterCreate'
  | 'afterRevise'
  | 'afterStatusChanged'
  | 'afterObservationAdded';

/**
 * The in-flight artifact payload passed to `beforeCreate` and `beforeRevise`
 * hooks.
 *
 * All fields are readonly — hooks mutate the draft through {@link BeforeArtifactHookContext.updateDraft}.
 */
export interface ArtifactDraft {
  /** Artifact kind discriminator. */
  readonly kind: string;
  /** Schema version used to interpret `data`. */
  readonly schemaVersion: number;
  /** Scope at which this artifact is relevant. */
  readonly scope: ArtifactScope;
  /** Kind-specific payload, not yet schema-validated. */
  readonly data: Record<string, unknown>;
  /** Typed directional links to other artifacts or external evidence. */
  readonly relations: readonly ArtifactRelation[];
  /** Optional confidence metadata attached to this draft. */
  readonly confidence?: ArtifactRevision['confidence'];
  /** Optional human-readable rendering hints. */
  readonly representations?: ArtifactRepresentations;
  /** Actor that produced this draft. */
  readonly actor: ArtifactActor;
}

/**
 * Partial update applied to a draft via {@link BeforeArtifactHookContext.updateDraft}.
 *
 * Only fields explicitly present in the patch are merged; absent fields are
 * left unchanged.
 */
export interface ArtifactDraftPatch {
  /** Replacement kind-specific payload. */
  readonly data?: Record<string, unknown>;
  /** Replacement relation set. */
  readonly relations?: readonly ArtifactRelation[];
  /** Replacement confidence metadata. Set to `undefined` to clear it. */
  readonly confidence?: ArtifactRevision['confidence'] | undefined;
  /** Replacement rendering hints. Set to `undefined` to clear them. */
  readonly representations?: ArtifactRepresentations | undefined;
  /** Replacement actor identity. */
  readonly actor?: ArtifactActor;
}

/**
 * Context object supplied to `beforeCreate` and `beforeRevise` hooks.
 *
 * Hooks may call {@link rejectCreation} to abort the write, {@link skipMaterialization}
 * to prevent projection to external providers, or {@link updateDraft} to patch
 * the in-flight payload before it is persisted.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface BeforeArtifactHookContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Discriminates between `beforeCreate` and `beforeRevise` in shared handlers. */
  readonly event: 'beforeCreate' | 'beforeRevise';
  /** The in-flight draft payload. */
  readonly draft: ArtifactDraft;
  /** Previous persisted revision, present only for `beforeRevise`. */
  readonly previous?: ArtifactRevision;
  /** Kind registration metadata, if the kind has been registered. */
  readonly kindRegistration?: ArtifactKindRegistration;
  /** Runtime bus for dispatching auxiliary events during validation. */
  readonly bus: TBus;
  /** Mutable metadata bag for passing data between hooks in the same pipeline run. */
  readonly meta: Map<string, unknown>;
  /**
   * Reject the pending create or revise with a reason string.
   *
   * The artifact service will surface this as an error to the caller.
   * @param reason - Human-readable rejection reason.
   */
  rejectCreation(reason: string): void;
  /**
   * Suppress materialization of this revision to external providers.
   *
   * The artifact is still persisted; only projection is skipped.
   */
  skipMaterialization(): void;
  /**
   * Apply a partial patch to the in-flight draft.
   *
   * Only fields present in `patch` are merged; others remain unchanged.
   * @param patch - Fields to merge into the current draft.
   */
  updateDraft(patch: ArtifactDraftPatch): void;
}

/**
 * Context object supplied to `afterCreate`, `afterRevise`, `afterStatusChanged`,
 * and `afterObservationAdded` hooks.
 *
 * After hooks run once a write has succeeded and may call
 * {@link preventDefault} to suppress later hooks in the negative-priority
 * default-projection tier. Hooks at priority `>= 0` and host-side bus
 * emissions outside the hook registry are unaffected.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface AfterArtifactHookContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Specific hook-trigger event. */
  readonly event: 'afterCreate' | 'afterRevise' | 'afterStatusChanged' | 'afterObservationAdded';
  /**
   * Semantic event that triggered this hook.
   *
   * One write can produce multiple semantic events (e.g. a revise that also
   * changes status yields both `revised` and `status-changed`).
   */
  readonly semanticEvent: ArtifactLifecycleSemanticEvent;
  /** The persisted artifact revision that was just written. */
  readonly artifact: ArtifactRevision;
  /** Reference to the previous revision, if this is a revise or status-change. */
  readonly previous?: ArtifactRef;
  /** The observation appended by afterObservationAdded. */
  readonly observation?: ArtifactObservation;
  /** Current registration metadata, when registered. */
  readonly kindRegistration?: ArtifactKindRegistration;
  /** Runtime bus for dispatching follow-up events or RPCs. */
  readonly bus: TBus;
  /**
   * Immutable metadata bag propagated from the paired `before*` hook run.
   *
   * Keys written into {@link BeforeArtifactHookContext.meta} are available
   * here as a `ReadonlyMap`.
   */
  readonly meta: ReadonlyMap<string, unknown>;
  /**
   * Suppress later hooks in the negative-priority default-projection tier.
   *
   * Hooks at priority `>= 0` still run. This does not suppress host-side bus
   * emissions or other work performed outside the after-hook registry.
   */
  preventDefault(): void;
  /**
   * Resolve all artifact revisions linked via a given relation type.
   * @param type - Relation type string to follow from this artifact.
   * @returns Resolved revisions in the order they appear in the relation set.
   */
  resolveRelations(type: string): Promise<readonly ArtifactRevision[]>;
}

/**
 * Optional filter that restricts a hook to a subset of artifact kinds or
 * schema versions.
 *
 * When absent, the hook runs for every artifact regardless of kind.
 */
export interface ArtifactHookFilter {
  /**
   * Artifact kind string to match, or `'*'` to match all kinds explicitly.
   *
   * When absent the hook runs for every kind.
   */
  readonly kind?: string | '*';
  /** Schema version to match. When absent the hook runs for every version. */
  readonly schemaVersion?: number;
}

/**
 * Registration record for a `beforeCreate` or `beforeRevise` guard hook.
 *
 * Guard hooks run synchronously in priority order before the artifact is
 * persisted. A guard may reject the write or patch the draft.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface BeforeArtifactHookRegistration<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Stable identifier for this hook. Dot-namespaced by convention, e.g. `'planner.require-scope'`. */
  readonly id: string;
  /** The lifecycle event this hook is triggered by. */
  readonly event: 'beforeCreate' | 'beforeRevise';
  /**
   * Optional filter restricting which artifact kinds trigger this hook.
   *
   * When absent the hook runs for every artifact.
   */
  readonly filter?: ArtifactHookFilter;
  /**
   * Numeric priority for ordering hooks of the same event.
   *
   * Higher numbers run first. Defaults to `0` when absent.
   */
  readonly priority?: number;
  /**
   * Hook implementation.
   * @param ctx - Full before-hook context for the current artifact write.
   */
  readonly handler: (ctx: BeforeArtifactHookContext<TBus>) => void | Promise<void>;
}

/**
 * Registration record for an `afterCreate`, `afterRevise`, `afterStatusChanged`,
 * or `afterObservationAdded` after hook.
 *
 * After hooks run once a write has succeeded and may perform side-effects such
 * as emitting additional bus events or triggering external provider syncs.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface AfterArtifactHookRegistration<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Stable identifier for this hook. Dot-namespaced by convention, e.g. `'planner.notify-owner'`. */
  readonly id: string;
  /** The lifecycle event this hook is triggered by. */
  readonly event: 'afterCreate' | 'afterRevise' | 'afterStatusChanged' | 'afterObservationAdded';
  /**
   * Optional filter restricting which artifact kinds trigger this hook.
   *
   * When absent the hook runs for every artifact.
   */
  readonly filter?: ArtifactHookFilter;
  /**
   * Numeric priority for ordering hooks of the same event.
   *
   * Higher numbers run first. Defaults to `0` when absent. Negative
   * priorities form the default-projection tier that can be skipped by
   * `preventDefault()`.
   */
  readonly priority?: number;
  /**
   * Hook implementation.
   * @param ctx - Full after-hook context for the completed artifact write.
   */
  readonly handler: (ctx: AfterArtifactHookContext<TBus>) => void | Promise<void>;
}

/**
 * Discriminated union of all artifact lifecycle hook registration variants.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export type ArtifactLifecycleHookRegistration<TBus extends MakaioBusLike = MakaioBusLike> =
  | BeforeArtifactHookRegistration<TBus>
  | AfterArtifactHookRegistration<TBus>;

/**
 * A named, immutable container of artifact lifecycle hook registrations.
 *
 * Produced by {@link defineArtifactLifecycleHooks}. The hooks are live-only and
 * are never included in bus-transportable registration payloads.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface ArtifactLifecycleHookDefinition<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Ordered set of hook registrations owned by this definition. */
  readonly hooks: readonly ArtifactLifecycleHookRegistration<TBus>[];
}

/**
 * Creates an immutable artifact lifecycle hook definition.
 *
 * The returned object wraps a shallow copy of the supplied hooks array so
 * that callers cannot mutate the definition after construction.
 *
 * Hook definitions are live-only — they carry function references and must
 * not be serialized or transmitted over the bus. They are attached to
 * {@link ArtifactKindDefinition} via the `hooks` field, which the
 * `toRegistration()` method deliberately omits.
 * @param definition - Hook registrations to include in the definition.
 * @returns An immutable {@link ArtifactLifecycleHookDefinition}.
 * @example
 * ```ts
 * export const plannerHooks = defineArtifactLifecycleHooks({
 *   hooks: [
 *     {
 *       id: 'planner.require-scope',
 *       event: 'beforeCreate',
 *       filter: { kind: 'implementation-plan' },
 *       handler: (ctx) => {
 *         if (!ctx.draft.scope.ids?.projectId) {
 *           ctx.rejectCreation('implementation-plan requires a projectId scope');
 *         }
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export function defineArtifactLifecycleHooks<TBus extends MakaioBusLike = MakaioBusLike>(
  definition: ArtifactLifecycleHookDefinition<TBus>,
): ArtifactLifecycleHookDefinition<TBus> {
  return { hooks: [...definition.hooks] };
}
