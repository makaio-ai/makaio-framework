import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  MaterializationSubjects,
  ArtifactViewModelSchema,
  ArtifactViewResolveRequestSchema,
  type ArtifactProjectionPolicy,
  type ArtifactRef,
  type ArtifactViewAffordanceDeclaration,
  type ArtifactViewAffordanceRequest,
  type ArtifactViewLevel,
  type ArtifactViewNavigation,
  type ArtifactViewResolveResponse,
  type ArtifactViewSection,
  type ResolvedArtifactContextWire,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import type { ArtifactSchemaRegistry } from '../artifact/artifact-schema-registry.js';
import type { ArtifactViewBuilderRegistry } from './artifact-view-builder-registry.js';
import { buildGenericArtifactView, GENERIC_ARTIFACT_VIEW_BUILDER_VERSION } from './generic-artifact-view-builder.js';

/* -------------------------------------------------------------------------- */
/*  Affordance truth table                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Interpret the affordance truth table to determine whether a request should
 * proceed to rendering.
 *
 * Truth table:
 * - Present non-empty affordances: exact and authoritative. Only declared
 *   affordances match. Inline `as` (declaration policy) defaults to `full`
 *   when omitted, so omitted `as` matches only request level `full`.
 * - Present empty affordances: render nowhere regardless of mode.
 * - Absent affordances (legacy defaults based on mode):
 *   - `none`: no rendering.
 *   - `surface`: own-view at `full` level.
 *   - `comment`: caller-supplied inline at `summary` level (no host-relation
 *     validation).
 * @param projection - The kind registration's projection policy, or undefined.
 * @param requestAffordance - The structural affordance selector from the request.
 * @param requestLevel - The top-level requested detail level.
 * @returns `true` if the request should proceed to rendering.
 */
export function isAffordancePermitted(
  projection: ArtifactProjectionPolicy | undefined,
  requestAffordance: ArtifactViewAffordanceRequest,
  requestLevel: ArtifactViewLevel,
): boolean {
  const affordances = projection?.affordances;

  // Absent affordances: legacy defaults
  if (affordances === undefined) {
    const mode = projection?.mode ?? 'none';
    switch (mode) {
      case 'none':
        return false;
      case 'surface':
        return requestAffordance.kind === 'own-view' && requestLevel === 'full';
      case 'comment':
        return requestAffordance.kind === 'inline' && requestLevel === 'summary';
    }
  }

  // Present empty array: render nowhere
  if (affordances.length === 0) {
    return false;
  }

  // Present non-empty affordances: exact and authoritative
  return affordances.some((decl) => matchesAffordance(decl, requestAffordance, requestLevel));
}

/**
 * Test whether a single declared affordance matches a request.
 * @param declaration - The affordance declaration from the kind registration.
 * @param request - The structural affordance selector from the request.
 * @param requestLevel - The top-level requested detail level.
 * @returns `true` if the declaration matches.
 */
function matchesAffordance(
  declaration: ArtifactViewAffordanceDeclaration,
  request: ArtifactViewAffordanceRequest,
  requestLevel: ArtifactViewLevel,
): boolean {
  if (declaration.kind !== request.kind) return false;

  switch (declaration.kind) {
    case 'own-view':
      // own-view is always at full level
      return requestLevel === 'full';

    case 'inline': {
      const requestInline = request as Extract<ArtifactViewAffordanceRequest, { kind: 'inline' }>;
      if (declaration.hostRelation !== requestInline.hostRelation) return false;
      // Exact-equality matching: the request level must equal the declared
      // `as`. Omitted `as` defaults to `full` — matches only request level
      // `full`.
      const declaredLevel = declaration.as ?? 'full';
      return requestLevel === declaredLevel;
    }

    case 'entry': {
      const requestEntry = request as Extract<ArtifactViewAffordanceRequest, { kind: 'entry' }>;
      if (declaration.via !== undefined && requestEntry.via !== undefined) {
        return declaration.via === requestEntry.via;
      }
      if (declaration.collection !== undefined && requestEntry.collection !== undefined) {
        return declaration.collection === requestEntry.collection;
      }
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Artifact View Service                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Framework service that resolves artifact views through the
 * `materialization.artifact.view.resolve` bus RPC.
 *
 * Resolution flow:
 * 1. Resolve the exact artifact revision via `ArtifactSubjects.resolve`.
 * 2. Load the kind registration from the schema registry.
 * 3. Interpret the affordance truth table.
 * 4. Select an exact custom builder from the builder registry.
 * 5. Build generic sections via `buildGenericArtifactView`.
 * 6. Optionally resolve default context via `ArtifactSubjects.resolveContext`.
 * 7. Dispatch the custom builder and apply its result.
 * 8. Validate the final `ArtifactViewModel` via Zod parse.
 * 9. Return the response with the appropriate builder version.
 *
 * No provider lookup, queueing, storage access, reference expansion,
 * fingerprinting, or `find` operations.
 */
export class ArtifactViewService extends BaseService {
  private readonly schemaRegistry: ArtifactSchemaRegistry;
  private readonly builderRegistry: ArtifactViewBuilderRegistry;

  /**
   * @param bus - Bus instance for handler registration and RPC calls.
   * @param schemaRegistry - Artifact schema registry for kind lookups.
   * @param builderRegistry - Builder registry for custom builder dispatch.
   */
  public constructor(
    bus: IMakaioBus,
    schemaRegistry: ArtifactSchemaRegistry,
    builderRegistry: ArtifactViewBuilderRegistry,
  ) {
    super(bus);
    this.schemaRegistry = schemaRegistry;
    this.builderRegistry = builderRegistry;
  }

  /** Register the resolve handler on the bus. */
  protected async onInit(): Promise<void> {
    this.registerHandler(MaterializationSubjects.artifact.view.resolve, async (ctx) => {
      const { ref, level, affordance, params } = ArtifactViewResolveRequestSchema.parse(ctx.payload);
      const result = await this.resolve(ref, level, affordance, params);
      ctx.setResult(result);
    });
  }

  /**
   * Resolve an artifact view through the affordance truth table and builder
   * dispatch pipeline.
   * @param ref - Immutable reference to the artifact revision to render.
   * @param level - Requested detail level.
   * @param affordance - Structural affordance selector.
   * @param params - Optional JSON-safe runtime parameters.
   * @returns Discriminated resolve response.
   */
  private async resolve(
    ref: ArtifactRef,
    level: ArtifactViewLevel,
    affordance: ArtifactViewAffordanceRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<ArtifactViewResolveResponse> {
    // Step 1: Resolve precisely the requested immutable artifact revision.
    const resolveResult = await this.bus.requestOptional(ArtifactSubjects.resolve, { ref });

    if (!resolveResult.handled || resolveResult.data.artifact === null) {
      return { status: 'artifact-not-found', view: null };
    }

    const artifact = resolveResult.data.artifact;

    // Step 2: Load kind registration from the schema registry
    const registration = this.schemaRegistry.getKind(artifact.kind, artifact.schemaVersion);
    if (registration === undefined) {
      // Kind not registered — cannot determine projection policy
      return { status: 'not-rendered', view: null };
    }

    // Step 3: Interpret affordance truth table
    if (!isAffordancePermitted(registration.projection, affordance, level)) {
      return { status: 'not-rendered', view: null };
    }

    // Step 4: Select custom builder (exact kind + schemaVersion match)
    const customBuilder = this.builderRegistry.getBuilder(artifact.kind, artifact.schemaVersion);

    // Step 5: Build generic sections
    const genericView = buildGenericArtifactView(artifact, registration, level);

    // Step 6: Resolve default context only when a custom builder exists AND
    // the kind registration declares defaultContext
    let resolvedDefaultContext: ResolvedArtifactContextWire | undefined;
    if (customBuilder !== undefined && registration.defaultContext !== undefined) {
      const contextResult = await this.bus.requestOptional(ArtifactSubjects.resolveContext, {
        ref,
      });
      if (contextResult.handled) {
        // Pass the resolved context graph through to the builder context.
        // The resolveContext RPC uses the kind's own defaultContext selectors
        // (no caller selectors are supplied) and returns the resolved graph.
        resolvedDefaultContext = contextResult.data.context;
      }
    }

    // Step 7: Dispatch custom builder if selected
    let finalSections: readonly ArtifactViewSection[] = genericView.sections;
    let finalNavigation: ArtifactViewNavigation = genericView.navigation;
    let builderVersion = GENERIC_ARTIFACT_VIEW_BUILDER_VERSION;

    if (customBuilder !== undefined) {
      // Always report the custom builder's version when one was selected,
      // even when it returns undefined (generic sections kept)
      builderVersion = customBuilder.version;

      const builderResult = await customBuilder.build({
        artifact,
        level,
        affordance,
        params,
        genericSections: genericView.sections,
        genericNavigation: genericView.navigation,
        relations: artifact.relations,
        defaultContext: resolvedDefaultContext,
      });

      if (builderResult !== undefined) {
        if ('render' in builderResult && builderResult.render === false) {
          return { status: 'not-rendered', view: null };
        }
        if ('sections' in builderResult) {
          finalSections = builderResult.sections ?? finalSections;
        }
        if ('navigation' in builderResult) {
          finalNavigation = builderResult.navigation ?? finalNavigation;
        }
      }
      // undefined result: keep generic sections, report custom builder version
    }

    // Step 8: Assemble and validate the final view model
    const viewModel = {
      title: genericView.title,
      artifact: genericView.artifact,
      navigation: finalNavigation,
      sections: [...finalSections],
      links: genericView.links,
    };

    const validated = ArtifactViewModelSchema.parse(viewModel);

    return {
      status: 'ok',
      view: validated,
      builderVersion,
      sourceRevision: ref.revision,
    };
  }
}
