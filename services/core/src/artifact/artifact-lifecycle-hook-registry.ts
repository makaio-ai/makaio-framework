import type { IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import type {
  AfterArtifactHookContext,
  AfterArtifactHookRegistration,
  ArtifactDraft,
  ArtifactDraftPatch,
  ArtifactHookFilter,
  ArtifactKindRegistration,
  ArtifactLifecycleHookRegistration,
  ArtifactObservation,
  ArtifactRef,
  ArtifactRelationTarget,
  ArtifactRevision,
  BeforeArtifactHookContext,
  BeforeArtifactHookRegistration,
} from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link ArtifactLifecycleHookRegistry.runBeforeCreate} and
 * {@link ArtifactLifecycleHookRegistry.runBeforeRevise}.
 */
export interface RunBeforeResult {
  /** The draft artifact after all guard hooks have applied their patches. */
  readonly draft: ArtifactRevision;
  /** Whether any hook called {@link BeforeArtifactHookContext.skipMaterialization}. */
  readonly skipMaterialization: boolean;
  /**
   * Metadata bag populated by before-hooks.
   *
   * Propagated to the paired after-hook run so hooks can communicate state
   * (e.g. previous field snapshots) across the before/after boundary without
   * re-fetching from storage.
   */
  readonly meta: Map<string, unknown>;
}

/**
 * Input accepted by {@link ArtifactLifecycleHookRegistry.runBeforeCreate} and
 * {@link ArtifactLifecycleHookRegistry.runBeforeRevise}.
 */
export interface RunBeforeInput {
  /** The in-flight draft revision to pass through before-hooks. */
  readonly draft: ArtifactRevision;
  /** The previous revision, present only for `beforeRevise`. */
  readonly previous?: ArtifactRevision;
  /** Kind registration metadata if the kind has been registered. */
  readonly kindRegistration: ArtifactKindRegistration | undefined;
}

/**
 * Input accepted by {@link ArtifactLifecycleHookRegistry.runAfterCreate},
 * {@link ArtifactLifecycleHookRegistry.runAfterRevise},
 * {@link ArtifactLifecycleHookRegistry.runAfterStatusChanged}, and
 * {@link ArtifactLifecycleHookRegistry.runAfterObservationAdded}.
 */
export interface RunAfterInput {
  /** The persisted artifact revision that was just written. */
  readonly artifact: ArtifactRevision;
  /** Reference to the previous revision, present only for revise / status-change. */
  readonly previous?: ArtifactRevision;
  /**
   * The observation that was just appended.
   *
   * Present only for {@link ArtifactLifecycleHookRegistry.runAfterObservationAdded}.
   * Forwarded to {@link AfterArtifactHookContext.observation} so that
   * `afterObservationAdded` hooks can inspect the observation without an
   * additional bus round-trip.
   */
  readonly observation?: ArtifactObservation;
  /** Kind registration metadata if the kind has been registered. */
  readonly kindRegistration: ArtifactKindRegistration | undefined;
  /**
   * Skip the default provider projection tier while preserving custom after hooks.
   *
   * The lifecycle writer sets this when a before-hook called
   * `skipMaterialization()`. Hooks at priority `>= 0` still run; hooks at
   * negative priority are the suppressible default-projection tier.
   */
  readonly skipDefaultProjection?: boolean;
  /**
   * Metadata bag propagated from the paired before-hook run.
   * A mutable `Map` is accepted but exposed as read-only to after hooks.
   */
  readonly meta: Map<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link ArtifactLifecycleHookRegistry.runBeforeCreate} or
 * {@link ArtifactLifecycleHookRegistry.runBeforeRevise} when a guard hook
 * calls {@link BeforeArtifactHookContext.rejectCreation}.
 *
 * The artifact service catches this error and surfaces it as a rejection to the
 * caller without rolling back any previous side-effects.
 */
export class ArtifactLifecycleHookRejectedError extends Error {
  /**
   * @param reason - Human-readable rejection reason supplied by the hook.
   * @param hookId - Stable identifier of the hook that rejected the write.
   */
  public constructor(
    public readonly reason: string,
    public readonly hookId: string,
  ) {
    super(`Artifact write rejected by hook '${hookId}': ${reason}`);
    this.name = 'ArtifactLifecycleHookRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether a hook's optional {@link ArtifactHookFilter} matches a
 * given artifact revision.
 * @param filter - The filter to evaluate, or `undefined` to match all.
 * @param artifact - The artifact revision to test against the filter.
 * @returns `true` if the artifact passes the filter.
 */
function matchesFilter(filter: ArtifactHookFilter | undefined, artifact: ArtifactRevision): boolean {
  if (!filter) return true;
  if (filter.kind !== undefined && filter.kind !== '*' && filter.kind !== artifact.kind) return false;
  if (filter.schemaVersion !== undefined && filter.schemaVersion !== artifact.schemaVersion) return false;
  return true;
}

/**
 * Extracts the numeric priority from a hook registration, defaulting to `0`.
 * @param hook - Hook registration to read priority from.
 * @returns The effective priority value.
 */
function effectivePriority(hook: ArtifactLifecycleHookRegistration<IMakaioBus>): number {
  return hook.priority ?? 0;
}

/**
 * Select and sort before-hooks matching a given event type and artifact.
 *
 * Hooks are returned in descending priority order (highest first).
 * @param hooks - Full flat list of registered hooks.
 * @param event - Before-hook event type to match.
 * @param artifact - Artifact being processed, used for filter evaluation.
 * @returns Sorted array of matching before-hook registrations.
 */
function selectBeforeHooks(
  hooks: readonly ArtifactLifecycleHookRegistration<IMakaioBus>[],
  event: 'beforeCreate' | 'beforeRevise',
  artifact: ArtifactRevision,
): BeforeArtifactHookRegistration<IMakaioBus>[] {
  return (
    hooks.filter(
      (h) => h.event === event && matchesFilter(h.filter, artifact),
    ) as BeforeArtifactHookRegistration<IMakaioBus>[]
  ).sort((a, b) => effectivePriority(b) - effectivePriority(a));
}

/**
 * Select and sort after-hooks matching a given event type and artifact.
 *
 * Hooks are returned in descending priority order (highest first).
 * @param hooks - Full flat list of registered hooks.
 * @param event - After-hook event type to match.
 * @param artifact - Artifact being processed, used for filter evaluation.
 * @returns Sorted array of matching after-hook registrations.
 */
function selectAfterHooks(
  hooks: readonly ArtifactLifecycleHookRegistration<IMakaioBus>[],
  event: 'afterCreate' | 'afterRevise' | 'afterStatusChanged' | 'afterObservationAdded',
  artifact: ArtifactRevision,
): AfterArtifactHookRegistration<IMakaioBus>[] {
  return (
    hooks.filter(
      (h) => h.event === event && matchesFilter(h.filter, artifact),
    ) as AfterArtifactHookRegistration<IMakaioBus>[]
  ).sort((a, b) => effectivePriority(b) - effectivePriority(a));
}

/**
 * Merge a {@link ArtifactDraftPatch} into an existing {@link ArtifactDraft},
 * returning a new object that reflects only the fields present in the patch.
 * @param current - Current draft state.
 * @param patch - Partial update to apply.
 * @returns Updated draft.
 */
function applyPatch(current: ArtifactDraft, patch: ArtifactDraftPatch): ArtifactDraft {
  return {
    ...current,
    ...('data' in patch ? { data: patch.data } : {}),
    ...('relations' in patch ? { relations: patch.relations } : {}),
    ...('confidence' in patch ? { confidence: patch.confidence } : {}),
    ...('representations' in patch ? { representations: patch.representations } : {}),
    ...('actor' in patch ? { actor: patch.actor } : {}),
  };
}

/**
 * Project a patched {@link ArtifactDraft} back onto the original
 * {@link ArtifactRevision}, preserving identity fields (`id`, `revision`,
 * `timestamp`, `scope`, `kind`, `schemaVersion`) from the original.
 * @param original - The original revision carrying identity fields.
 * @param draft - The (possibly patched) draft.
 * @returns Updated revision with identity fields intact.
 */
function mergeBack(original: ArtifactRevision, draft: ArtifactDraft): ArtifactRevision {
  const { confidence: _confidence, representations: _representations, ...base } = original;
  return {
    ...base,
    data: draft.data,
    relations: [...draft.relations],
    ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
    ...(draft.representations !== undefined ? { representations: draft.representations } : {}),
    actor: draft.actor,
  };
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

/**
 * In-process registry for artifact lifecycle hooks.
 *
 * Maintains a flat list of hook registrations contributed by extension owners.
 * Each call to {@link registerHooks} returns a cleanup function that removes
 * exactly the hooks registered in that call.
 *
 * The bus is accepted at construction time so that after-hook contexts can
 * issue RPC calls (e.g. `ArtifactSubjects.resolve`) during hook execution.
 */
export class ArtifactLifecycleHookRegistry extends BaseService {
  private readonly registrations = new Map<string, readonly ArtifactLifecycleHookRegistration<IMakaioBus>[]>();

  /**
   * @param bus - Bus instance passed through to hook context objects.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * No-op service initialisation hook.
   *
   * The registry requires no bus handlers of its own; it is ready as soon as
   * it is constructed. The hook exists to satisfy the {@link BaseService}
   * lifecycle contract.
   */
  protected override async onInit(): Promise<void> {
    // No bus handlers needed — registration is managed by contribution processors.
  }

  /**
   * Service teardown hook.
   *
   * Clears all in-memory hook registrations so the instance can be
   * garbage-collected without retaining hook closures.
   */
  protected override onDestroy(): void {
    this.registrations.clear();
  }

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  /**
   * Register a set of lifecycle hooks on behalf of an owner.
   *
   * Calling this method again with the same `owner` replaces the previous
   * registration for that owner. The returned cleanup function removes only the
   * hooks registered by this call; it is idempotent.
   * @param owner - Stable owner identifier (typically the extension name).
   * @param hooks - Hook registrations to install.
   * @returns Cleanup function that unregisters the supplied hooks.
   */
  public registerHooks(owner: string, hooks: readonly ArtifactLifecycleHookRegistration<IMakaioBus>[]): () => void {
    const snapshot = [...hooks];
    this.registrations.set(owner, snapshot);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (this.registrations.get(owner) === snapshot) {
        this.registrations.delete(owner);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Internal aggregator
  // --------------------------------------------------------------------------

  /**
   * Flatten all registered hooks from all owners into a single array.
   * @returns All currently registered hooks.
   */
  private allHooks(): readonly ArtifactLifecycleHookRegistration<IMakaioBus>[] {
    const result: ArtifactLifecycleHookRegistration<IMakaioBus>[] = [];
    for (const hooks of this.registrations.values()) {
      result.push(...hooks);
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Before-hooks
  // --------------------------------------------------------------------------

  /**
   * Build and run all `beforeCreate` hooks against the supplied draft revision.
   *
   * Hooks run in descending priority order (highest first). If any hook calls
   * {@link BeforeArtifactHookContext.rejectCreation}, the pipeline stops and
   * throws {@link ArtifactLifecycleHookRejectedError}.
   * @param input - The in-flight draft and optional kind metadata.
   * @returns The final patched revision and a flag indicating whether
   *   materialization should be skipped.
   * @throws {@link ArtifactLifecycleHookRejectedError} when a hook rejects the write.
   */
  public async runBeforeCreate(input: RunBeforeInput): Promise<RunBeforeResult> {
    return this.runBeforeHooks('beforeCreate', input);
  }

  /**
   * Build and run all `beforeRevise` hooks against the supplied draft revision.
   *
   * Semantics are identical to {@link runBeforeCreate}.
   * @param input - The in-flight draft and optional kind metadata.
   * @returns The final patched revision and skip-materialization flag.
   * @throws {@link ArtifactLifecycleHookRejectedError} when a hook rejects the write.
   */
  public async runBeforeRevise(input: RunBeforeInput): Promise<RunBeforeResult> {
    return this.runBeforeHooks('beforeRevise', input);
  }

  /**
   * Shared implementation for before-hook pipelines.
   * @param event - The specific before-hook event type.
   * @param input - Input carrying the draft and context fields.
   * @returns The final patched revision and skip-materialization flag.
   */
  private async runBeforeHooks(
    event: 'beforeCreate' | 'beforeRevise',
    input: RunBeforeInput,
  ): Promise<RunBeforeResult> {
    const { draft: inputRevision, previous, kindRegistration } = input;
    const hooks = selectBeforeHooks(this.allHooks(), event, inputRevision);
    const meta = new Map<string, unknown>();

    let currentDraft: ArtifactDraft = {
      kind: inputRevision.kind,
      schemaVersion: inputRevision.schemaVersion,
      scope: inputRevision.scope,
      data: inputRevision.data,
      relations: inputRevision.relations,
      ...(inputRevision.confidence !== undefined ? { confidence: inputRevision.confidence } : {}),
      ...(inputRevision.representations !== undefined ? { representations: inputRevision.representations } : {}),
      actor: inputRevision.actor,
    };
    let skipMat = false;

    for (const hook of hooks) {
      let rejected: { reason: string } | undefined;

      const ctx: BeforeArtifactHookContext<IMakaioBus> = {
        event,
        get draft() {
          return currentDraft;
        },
        previous,
        kindRegistration,
        bus: this.bus,
        meta,
        rejectCreation(reason: string): void {
          rejected = { reason };
        },
        skipMaterialization(): void {
          skipMat = true;
        },
        updateDraft(patch: ArtifactDraftPatch): void {
          currentDraft = applyPatch(currentDraft, patch);
        },
      };

      await hook.handler(ctx);

      if (rejected) {
        throw new ArtifactLifecycleHookRejectedError(rejected.reason, hook.id);
      }
    }

    return {
      draft: mergeBack(inputRevision, currentDraft),
      skipMaterialization: skipMat,
      meta,
    };
  }

  // --------------------------------------------------------------------------
  // After-hooks
  // --------------------------------------------------------------------------

  /**
   * Run all `afterCreate` after hooks for a newly created artifact.
   *
   * Hooks run in descending priority order (highest first). Any hook may call
   * {@link AfterArtifactHookContext.preventDefault} to suppress subsequent
   * hooks in the negative-priority default-projection tier. Hooks at priority
   * `>= 0` still run. Errors thrown by individual hooks are caught and logged;
   * they never propagate to the caller.
   * @param input - After-hook context fields for the completed create.
   */
  public async runAfterCreate(input: RunAfterInput): Promise<void> {
    await this.runAfterHooks('afterCreate', 'created', input);
  }

  /**
   * Run all `afterRevise` after hooks for a revised artifact.
   * @param input - After-hook context fields for the completed revise.
   */
  public async runAfterRevise(input: RunAfterInput): Promise<void> {
    await this.runAfterHooks('afterRevise', 'revised', input);
  }

  /**
   * Run all `afterStatusChanged` after hooks.
   * @param input - After-hook context fields for the status change.
   */
  public async runAfterStatusChanged(input: RunAfterInput): Promise<void> {
    await this.runAfterHooks('afterStatusChanged', 'status-changed', input);
  }

  /**
   * Run all `afterObservationAdded` after hooks.
   * @param input - After-hook context fields for the observation.
   */
  public async runAfterObservationAdded(input: RunAfterInput): Promise<void> {
    await this.runAfterHooks('afterObservationAdded', 'observation-added', input);
  }

  /**
   * Shared implementation for after-hook pipelines.
   * @param event - The specific after-hook event type.
   * @param semanticEvent - The semantic event name passed to hook contexts.
   * @param input - After-hook context fields.
   */
  private async runAfterHooks(
    event: 'afterCreate' | 'afterRevise' | 'afterStatusChanged' | 'afterObservationAdded',
    semanticEvent: AfterArtifactHookContext['semanticEvent'],
    input: RunAfterInput,
  ): Promise<void> {
    const { artifact, previous, observation, kindRegistration, skipDefaultProjection, meta } = input;
    const hooks = selectAfterHooks(this.allHooks(), event, artifact);
    const bus = this.bus;

    let defaultPrevented = false;

    for (const hook of hooks) {
      if (skipDefaultProjection && (hook.priority ?? 0) < 0) continue;
      // When preventDefault() has been called, skip only hooks in the
      // "default projection" tier (priority < 0). Hooks at priority >= 0 are
      // always run regardless of preventDefault state.
      if (defaultPrevented && (hook.priority ?? 0) < 0) continue;

      const ctx: AfterArtifactHookContext<IMakaioBus> = {
        event,
        semanticEvent,
        artifact,
        previous: previous
          ? { refClass: 'artifact' as const, id: previous.id, revision: previous.revision, kind: previous.kind }
          : undefined,
        observation,
        kindRegistration,
        bus,
        meta,
        preventDefault(): void {
          defaultPrevented = true;
        },
        async resolveRelations(type: string): Promise<readonly ArtifactRevision[]> {
          const targets = artifact.relations.filter((r) => r.type === type).map((r) => r.target);
          const revisions: ArtifactRevision[] = [];
          for (const target of targets) {
            const t = target as ArtifactRelationTarget;
            if (t.refClass === 'artifact') {
              const artifactRef: ArtifactRef = t;
              const { artifact: resolved } = await bus.request(ArtifactSubjects.resolve, { ref: artifactRef });
              if (resolved) revisions.push(resolved);
            }
          }
          return revisions;
        },
      };

      try {
        await hook.handler(ctx);
      } catch (error) {
        console.error(`[ArtifactLifecycleHookRegistry] Hook '${hook.id}' threw during '${event}':`, error);
      }
    }
  }
}
