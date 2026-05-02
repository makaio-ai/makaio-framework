import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AIModelSchema, type AIModel } from '@makaio/contracts';
import {
  type ModelRegistry,
  ProviderModelOverrideSchema,
  mergeModelMetadata,
} from '@makaio/services-core/model-registry';
import { isRecord, listYamlFiles } from './fs-utils.js';

type LabRegistryEntryOverlay = Omit<ModelRegistry['labs'][string], 'name'> & { readonly name?: string };
type ProviderRegistryEntryOverlay = Omit<ModelRegistry['providers'][string], 'name'> & { readonly name?: string };

/**
 * Registry-shaped overlay that may contain provider references resolved by a base registry.
 */
export interface ModelRegistryOverlay {
  /** Timestamp declared by an overlay payload, when the author supplied one. */
  updatedAt?: string;
  /** Lab entries contributed by the overlay. */
  labs: Record<string, LabRegistryEntryOverlay>;
  /** Provider entries contributed by the overlay. */
  providers: Record<string, ProviderRegistryEntryOverlay>;
}

const LabRegistryEntryOverlaySchema = z.object({
  name: z.string().optional(),
  models: z.array(AIModelSchema),
});

const ProviderRegistryEntryOverlaySchema = z.object({
  name: z.string().optional(),
  models: z.record(z.string(), ProviderModelOverrideSchema),
});

const RegistryOverlayFileSchema = z.object({
  $schema: z.literal('makaio/model-registry/v2').optional(),
  updatedAt: z.string().datetime().optional(),
  labs: z.record(z.string(), LabRegistryEntryOverlaySchema).optional(),
  providers: z.record(z.string(), ProviderRegistryEntryOverlaySchema).optional(),
});

export const LabFileSchema = z.object({
  name: z.string().optional(),
  models: z.array(z.record(z.string(), z.unknown())),
});

export const ProviderFileSchema = z.object({
  name: z.string().optional(),
  models: z.record(z.string(), ProviderModelOverrideSchema),
});

/**
 * Internal parser for user override directories.
 *
 * Unlike {@link DirectoryRegistryFetcher}, this parser intentionally returns an
 * overlay that can reference lab models supplied by a base registry. Callers
 * must validate the final merged registry with {@link ModelRegistrySchema}.
 */
export class DirectoryRegistryOverlayFetcher {
  /**
   * Creates a new DirectoryRegistryOverlayFetcher.
   * @param userModelsDir - Absolute path to the user models directory.
   */
  public constructor(private readonly userModelsDir: string) {}

  /**
   * Fetch and parse overlay YAML files from the configured directory.
   * @returns Parsed overlay data without cross-registry provider reference validation.
   */
  public async fetch(): Promise<ModelRegistryOverlay> {
    const overlay = createEmptyOverlay();

    await Promise.all([
      this.loadLabDirectory(path.join(this.userModelsDir, 'labs'), overlay),
      this.loadProviderDirectory(path.join(this.userModelsDir, 'providers'), overlay),
    ]);
    await this.loadFlatFiles(overlay);

    return overlay;
  }

  /**
   * Load lab-style YAML files from a directory.
   * @param labsDir - Directory containing lab YAML files.
   * @param overlay - Overlay being assembled.
   */
  private async loadLabDirectory(labsDir: string, overlay: ModelRegistryOverlay): Promise<void> {
    const files = await listYamlFiles(labsDir);
    const entries = await Promise.all(
      files.map(async (file) => ({
        labId: path.basename(file, '.yaml'),
        lab: await readLabFile(file, path.basename(file, '.yaml')),
      })),
    );
    for (const { labId, lab } of entries) {
      applyLabOverlay(overlay, labId, lab);
    }
  }

  /**
   * Load provider-style YAML files from a directory.
   * @param providersDir - Directory containing provider YAML files.
   * @param overlay - Overlay being assembled.
   */
  private async loadProviderDirectory(providersDir: string, overlay: ModelRegistryOverlay): Promise<void> {
    const files = await listYamlFiles(providersDir);
    const entries = await Promise.all(
      files.map(async (file) => ({
        providerId: path.basename(file, '.yaml'),
        provider: await readProviderFile(file),
      })),
    );
    for (const { providerId, provider } of entries) {
      applyProviderOverlay(overlay, providerId, provider);
    }
  }

  /**
   * Load flat `.yaml` files from the configured directory.
   * @param overlay - Overlay being assembled.
   */
  private async loadFlatFiles(overlay: ModelRegistryOverlay): Promise<void> {
    const files = await listYamlFiles(this.userModelsDir);

    for (const file of files) {
      const fileId = path.basename(file, '.yaml');
      const content = await fs.promises.readFile(file, 'utf-8');
      const data: unknown = parseYaml(content);

      if (!isRecord(data)) {
        throw new Error(`Invalid model registry overlay YAML in ${file}: expected a YAML object.`);
      }

      if ('labs' in data || 'providers' in data) {
        mergeInto(overlay, RegistryOverlayFileSchema.parse(data));
        continue;
      }

      if (Array.isArray(data.models)) {
        applyLabOverlay(overlay, fileId, parseLabFile(data, fileId));
        continue;
      }

      if (isRecord(data.models)) {
        applyProviderOverlay(overlay, fileId, parseProviderFile(data));
        continue;
      }

      throw new Error(`Unrecognized model registry overlay shape in ${file}: expected labs, providers, or models.`);
    }
  }
}

/**
 * Create an empty registry overlay.
 * @returns Empty overlay payload.
 */
export function createEmptyOverlay(): ModelRegistryOverlay {
  return {
    labs: {},
    providers: {},
  };
}

/**
 * Convert an overlay to a standalone registry candidate.
 * @param overlay - Overlay to convert.
 * @param fallbackUpdatedAt - Deterministic timestamp to use when the overlay omits one.
 * @returns Registry-shaped payload.
 */
export function overlayToRegistry(overlay: ModelRegistryOverlay, fallbackUpdatedAt: string): ModelRegistry {
  return {
    $schema: 'makaio/model-registry/v2',
    updatedAt: overlay.updatedAt ?? fallbackUpdatedAt,
    labs: materializeLabEntries(overlay.labs),
    providers: materializeProviderEntries(overlay.providers),
  };
}

/**
 * Merge an overlay into a base registry.
 * @param base - Base registry.
 * @param overlay - Overlay entries to apply.
 * @returns Registry-shaped merged payload.
 */
export function mergeRegistryOverlay(base: ModelRegistry, overlay: ModelRegistryOverlay): ModelRegistry {
  return {
    $schema: 'makaio/model-registry/v2',
    updatedAt: overlay.updatedAt ?? base.updatedAt,
    labs: materializeLabEntries(mergeLabOverlays(base.labs, overlay.labs)),
    providers: materializeProviderEntries(mergeProviderOverlays(base.providers, overlay.providers)),
  };
}

/**
 * Merge lab entries by lab id.
 * @param baseLabs - Lab entries supplied by the base registry.
 * @param overlayLabs - Lab entries supplied by the overlay.
 * @returns Labs with overlay fields applied while retaining base-only models.
 */
function mergeLabOverlays(
  baseLabs: Record<string, LabRegistryEntryOverlay>,
  overlayLabs: Record<string, LabRegistryEntryOverlay>,
): Record<string, LabRegistryEntryOverlay> {
  const mergedLabs: Record<string, LabRegistryEntryOverlay> = { ...baseLabs };

  for (const [labId, overlayLab] of Object.entries(overlayLabs)) {
    const baseLab = mergedLabs[labId];
    mergedLabs[labId] =
      baseLab === undefined
        ? overlayLab
        : {
            ...baseLab,
            ...overlayLab,
            models: mergeLabModels(baseLab.models, overlayLab.models),
          };
  }

  return mergedLabs;
}

/**
 * Merge lab models by model name.
 * @param baseModels - Canonical models supplied by the base lab entry.
 * @param overlayModels - Canonical models supplied by the overlay lab entry.
 * @returns Models with overlay fields applied over matching base models.
 */
function mergeLabModels(baseModels: readonly AIModel[], overlayModels: readonly AIModel[]): AIModel[] {
  const mergedModels = [...baseModels];
  const modelIndexes = new Map(baseModels.map((model, index) => [model.name, index]));

  for (const overlayModel of overlayModels) {
    const modelIndex = modelIndexes.get(overlayModel.name);

    if (modelIndex === undefined) {
      modelIndexes.set(overlayModel.name, mergedModels.length);
      mergedModels.push(overlayModel);
      continue;
    }

    mergedModels[modelIndex] = mergeLabModel(mergedModels[modelIndex], overlayModel);
  }

  return mergedModels;
}

/**
 * Merge two lab models for the same model name.
 * @param baseModel - Canonical model supplied by the base lab entry.
 * @param overlayModel - Canonical model supplied by the overlay lab entry.
 * @returns Canonical model with overlay fields applied over the base model.
 */
function mergeLabModel(baseModel: AIModel, overlayModel: AIModel): AIModel {
  const mergedModel: AIModel = { ...baseModel, ...overlayModel };
  const metadata = mergeModelMetadata(baseModel.metadata, overlayModel.metadata);

  if (metadata === undefined) {
    delete mergedModel.metadata;
  } else {
    mergedModel.metadata = metadata;
  }

  return mergedModel;
}

/**
 * Merge provider entries by provider id.
 * @param baseProviders - Provider entries supplied by the base registry.
 * @param overlayProviders - Provider entries supplied by the overlay.
 * @returns Providers with overlay fields applied while retaining base-only models.
 */
function mergeProviderOverlays(
  baseProviders: Record<string, ProviderRegistryEntryOverlay>,
  overlayProviders: Record<string, ProviderRegistryEntryOverlay>,
): Record<string, ProviderRegistryEntryOverlay> {
  const mergedProviders: Record<string, ProviderRegistryEntryOverlay> = { ...baseProviders };

  for (const [providerId, overlayProvider] of Object.entries(overlayProviders)) {
    const baseProvider = mergedProviders[providerId];
    mergedProviders[providerId] =
      baseProvider === undefined
        ? overlayProvider
        : {
            ...baseProvider,
            ...overlayProvider,
            models: mergeProviderModelOverrides(baseProvider.models, overlayProvider.models),
          };
  }

  return mergedProviders;
}

/**
 * Merge provider model overrides by model name.
 * @param baseModels - Model overrides supplied by the base provider entry.
 * @param overlayModels - Model overrides supplied by the overlay provider entry.
 * @returns Model overrides with overlay fields applied over matching base models.
 */
function mergeProviderModelOverrides(
  baseModels: ModelRegistry['providers'][string]['models'],
  overlayModels: ModelRegistry['providers'][string]['models'],
): ModelRegistry['providers'][string]['models'] {
  const mergedModels: ModelRegistry['providers'][string]['models'] = { ...baseModels };

  for (const [modelName, overlayModel] of Object.entries(overlayModels)) {
    const baseModel = mergedModels[modelName];
    mergedModels[modelName] =
      baseModel === undefined ? overlayModel : mergeProviderModelOverride(baseModel, overlayModel);
  }

  return mergedModels;
}

/**
 * Merge two provider model overrides for the same model.
 * @param baseModel - Model override supplied by the base provider entry.
 * @param overlayModel - Model override supplied by the overlay provider entry.
 * @returns Model override with overlay fields applied over the base model.
 */
function mergeProviderModelOverride(
  baseModel: ModelRegistry['providers'][string]['models'][string],
  overlayModel: ModelRegistry['providers'][string]['models'][string],
): ModelRegistry['providers'][string]['models'][string] {
  const mergedModel: ModelRegistry['providers'][string]['models'][string] = { ...baseModel, ...overlayModel };
  const metadata = mergeModelMetadata(baseModel.metadata, overlayModel.metadata);

  if (metadata === undefined) {
    delete mergedModel.metadata;
  } else {
    mergedModel.metadata = metadata;
  }

  return mergedModel;
}

/**
 * Read and parse a lab-style YAML file.
 * @param file - YAML file path.
 * @param labId - Lab identifier inferred from the filename.
 * @returns Parsed lab registry entry.
 */
async function readLabFile(file: string, labId: string): Promise<LabRegistryEntryOverlay> {
  const content = await fs.promises.readFile(file, 'utf-8');
  const data: unknown = parseYaml(content);
  return parseLabFile(data, labId);
}

/**
 * Read and parse a provider-style YAML file.
 * @param file - YAML file path.
 * @returns Parsed provider registry entry.
 */
async function readProviderFile(file: string): Promise<ProviderRegistryEntryOverlay> {
  const content = await fs.promises.readFile(file, 'utf-8');
  const data: unknown = parseYaml(content);
  return parseProviderFile(data);
}

/**
 * Parse lab-style YAML data.
 * @param data - Parsed YAML payload.
 * @param labId - Lab identifier inferred from the filename.
 * @returns Parsed lab registry entry.
 */
export function parseLabFile(data: unknown, labId: string): LabRegistryEntryOverlay {
  const parsed = LabFileSchema.parse(data);
  return {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    models: parsed.models.map((model) => AIModelSchema.parse({ ...model, labId })),
  };
}

/**
 * Parse provider-style YAML data.
 * @param data - Parsed YAML payload.
 * @returns Parsed provider registry entry.
 */
export function parseProviderFile(data: unknown): ProviderRegistryEntryOverlay {
  const parsed = ProviderFileSchema.parse(data);
  return {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    models: parsed.models,
  };
}

/**
 * Mutate a target overlay by applying another overlay payload.
 * @param target - Overlay to mutate.
 * @param source - Overlay entries to apply.
 */
function mergeInto(target: ModelRegistryOverlay, source: z.infer<typeof RegistryOverlayFileSchema>): void {
  target.updatedAt = source.updatedAt ?? target.updatedAt;

  if (source.labs !== undefined) {
    target.labs = mergeLabOverlays(target.labs, source.labs);
  }

  if (source.providers !== undefined) {
    target.providers = mergeProviderOverlays(target.providers, source.providers);
  }
}

/**
 * Apply a single lab contribution through the overlay merge contract.
 * @param target - Overlay to mutate.
 * @param labId - Lab identifier being contributed.
 * @param lab - Lab entry supplied by one overlay file.
 */
function applyLabOverlay(target: ModelRegistryOverlay, labId: string, lab: LabRegistryEntryOverlay): void {
  target.labs = mergeLabOverlays(target.labs, { [labId]: lab });
}

/**
 * Apply a single provider contribution through the overlay merge contract.
 * @param target - Overlay to mutate.
 * @param providerId - Provider identifier being contributed.
 * @param provider - Provider entry supplied by one overlay file.
 */
function applyProviderOverlay(
  target: ModelRegistryOverlay,
  providerId: string,
  provider: ProviderRegistryEntryOverlay,
): void {
  target.providers = mergeProviderOverlays(target.providers, { [providerId]: provider });
}

/**
 * Materialize overlay lab entries into complete registry entries.
 * @param labs - Overlay lab entries keyed by lab id.
 * @returns Complete lab registry entries.
 */
function materializeLabEntries(labs: Record<string, LabRegistryEntryOverlay>): ModelRegistry['labs'] {
  return Object.fromEntries(Object.entries(labs).map(([labId, lab]) => [labId, { ...lab, name: lab.name ?? labId }]));
}

/**
 * Materialize overlay provider entries into complete registry entries.
 * @param providers - Overlay provider entries keyed by provider id.
 * @returns Complete provider registry entries.
 */
function materializeProviderEntries(
  providers: Record<string, ProviderRegistryEntryOverlay>,
): ModelRegistry['providers'] {
  return Object.fromEntries(
    Object.entries(providers).map(([providerId, provider]) => [
      providerId,
      { ...provider, name: provider.name ?? providerId },
    ]),
  );
}
