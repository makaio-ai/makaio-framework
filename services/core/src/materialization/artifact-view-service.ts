import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  MaterializationSubjects,
  ArtifactViewModelSchema,
  ArtifactViewResolveRequestSchema,
  type ArtifactRef,
  type ArtifactViewAffordanceRequest,
  type ArtifactViewLevel,
  type ArtifactViewNavigation,
  type ArtifactViewResolveResponse,
  type ArtifactViewSection,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import type { ArtifactSchemaRegistry } from '../artifact/artifact-schema-registry.js';
import type { ArtifactViewBuilderRegistry } from './artifact-view-builder-registry.js';
import { buildGenericArtifactView } from './generic-artifact-view-builder.js';

/**
 * Framework service that resolves artifact views through the
 * `materialization.artifact.view.resolve` bus RPC.
 *
 * Resolves the exact revision and requires an explicitly registered builder.
 * Kind-level projection policies and implicit context expansion are retired.
 * The generic skeleton supplies only title, direct relations, and evidence;
 * custom builders own the content and can decline a requested affordance.
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
   * Resolve an artifact view through an explicitly registered builder.
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
    // Resolve precisely the requested immutable artifact revision.
    const resolveResult = await this.bus.requestOptional(ArtifactSubjects.resolve, { ref });

    if (!resolveResult.handled || resolveResult.data.artifact === null) {
      return { status: 'artifact-not-found', view: null };
    }

    const artifact = resolveResult.data.artifact;

    // Load kind registration from the schema registry
    const registration = this.schemaRegistry.getKind(artifact.kind, artifact.schemaVersion);
    if (registration === undefined) {
      // Kind not registered — cannot resolve its title contract
      return { status: 'not-rendered', view: null };
    }

    // Rendering requires explicit builder ownership; absent kind policies do
    // not authorize exposing artifact content through a generic fallback.
    const customBuilder = this.builderRegistry.getBuilder(artifact.kind, artifact.schemaVersion);
    if (customBuilder === undefined) {
      return { status: 'not-rendered', view: null };
    }
    const genericView = buildGenericArtifactView(artifact, registration, level);

    // Dispatch the explicit builder.
    let finalSections: readonly ArtifactViewSection[] = genericView.sections;
    let finalNavigation: ArtifactViewNavigation = genericView.navigation;
    const builderVersion = customBuilder.version;

    const builderResult = await customBuilder.build({
      artifact,
      level,
      affordance,
      params,
      genericSections: genericView.sections,
      genericNavigation: genericView.navigation,
      relations: artifact.relations,
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
    // Assemble and validate the final view model
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
