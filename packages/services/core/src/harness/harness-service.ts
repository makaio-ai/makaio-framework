import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import {
  HarnessSubjects,
  HarnessDefinitionCreateSchema,
  AdapterSubjects,
  type HarnessDefinitionCreate,
} from '@makaio/contracts';
import { HarnessStorageSubjects, type Harness, type HarnessInput } from './storage/namespace.js';
import { seedDefaultHarnesses } from './default-harnesses.js';
import { registerDrizzleHarnessStorage } from './storage/handler.js';

interface HarnessLookupInput {
  id?: string;
  name?: string;
  adapterName?: string;
  clientId?: string;
}

/**
 * Return `patch` if defined, otherwise fall back to `existing`, then `defaultValue`.
 * Extracted to keep per-field merge logic out of the complexity budget of callers.
 * @param patch - Value from the incoming payload
 * @param existing - Value from the persisted record
 * @param defaultValue - Safe fallback when both are absent
 * @returns First defined value in patch → existing → defaultValue order
 */
function coalesce<T>(patch: T | undefined, existing: T | undefined, defaultValue: T): T {
  return patch ?? existing ?? defaultValue;
}

/**
 * Orchestrates harness lifecycle including CRUD and default resolution.
 */
export class HarnessService extends BaseService {
  /** Drizzle storage handler registration for the composition root. */
  public static readonly storage = {
    drizzle: registerDrizzleHarnessStorage,
  } as const;

  /**
   * Creates a new HarnessService instance.
   * @param bus - Bus instance for request/event handling
   */
  public constructor(bus: IMakaioBus = MakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    // Seed before registering handlers so a seeding failure leaves no registered handlers behind.
    // Runtime contract: NodeRuntime runs DB migrations before lifecycle services start.
    // Seeding assumes storage is ready and `harness_definitions` already exists.
    await seedDefaultHarnesses(this.bus);
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.registerHandler(HarnessSubjects.get, async (ctx) => {
      const harness = await this.loadHarness(ctx.payload);
      if (!harness) {
        throw new Error('Harness not found');
      }

      ctx.setResult(harness);
    });

    this.registerHandler(HarnessSubjects.list, async (ctx) => {
      const { harnesses } = await this.bus.request(HarnessStorageSubjects.list, ctx.payload);
      ctx.setResult({ harnesses });
    });

    this.registerHandler(HarnessSubjects.set, async (ctx) => {
      const id = await this.upsertHarness(ctx.payload);
      ctx.setResult({ id });
    });

    this.registerHandler(HarnessSubjects.delete, async (ctx) => {
      const { deleted } = await this.bus.request(HarnessStorageSubjects.delete, { id: ctx.payload.id });
      ctx.setResult({ success: deleted });
    });

    this.registerHandler(HarnessSubjects.getDefault, async (ctx) => {
      const harness = await this.getDefaultHarness(ctx.payload.adapterName, ctx.payload.clientId);
      ctx.setResult(harness);
    });

    this.registerHandler(HarnessSubjects.resolve, async (ctx) => {
      const { adapterName, clientId, personaHarnessId, profileHarnessId } = ctx.payload;

      if (personaHarnessId) {
        const personaHarness = await this.resolveAndValidateHarness(personaHarnessId, adapterName, 'persona', clientId);
        ctx.setResult(personaHarness);
        return;
      }

      if (profileHarnessId) {
        const profileHarness = await this.resolveAndValidateHarness(profileHarnessId, adapterName, 'profile', clientId);
        ctx.setResult(profileHarness);
        return;
      }

      const harness = await this.getDefaultHarness(adapterName, clientId);
      ctx.setResult(harness);
    });

    this.registerHandler(HarnessSubjects.getSchema, ({ setResult }) => {
      const jsonSchema = z.toJSONSchema(HarnessDefinitionCreateSchema);
      const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;
      setResult({
        schema,
        uiConfig: {
          editMode: 'fullPage',
          hiddenFields: ['isDefault'],
        },
      });
    });
  }

  /**
   * Resolve, merge with existing data, and persist a harness definition.
   *
   * Applies partial-update semantics: any field omitted from `payload` falls back
   * to the current persisted value, then to a safe default. This prevents
   * schema-driven editors from silently zeroing fields they don't render.
   * @param payload - Incoming create/update payload from the bus
   * @returns The stable harness ID
   */
  private async upsertHarness(payload: HarnessDefinitionCreate): Promise<string> {
    const id = await this.resolveHarnessId(payload.name, payload.adapterName, payload.clientId);
    const existing = await this.loadHarness({
      id,
      adapterName: payload.adapterName,
      clientId: payload.clientId,
    });
    const harness = this.mergeHarnessPayload(id, payload, existing);
    if (harness.adapterName) {
      await this.validateNativeTools(harness.adapterName, harness.nativeTools);
    }
    await this.bus.request(HarnessStorageSubjects.set, { harness });
    return id;
  }

  /**
   * Merge a harness create/update payload with existing persisted data.
   *
   * Any field omitted from `payload` falls back to the current persisted value,
   * then to a safe default. This prevents schema-driven editors that omit
   * read-only fields from silently resetting them.
   * @param id - Stable harness ID
   * @param payload - Incoming create/update payload
   * @param existing - Current persisted harness, if any
   * @returns Merged harness ready for storage
   */
  private mergeHarnessPayload(id: string, payload: HarnessDefinitionCreate, existing: Harness | null): HarnessInput {
    const emptySelection = { enabled: [], disabled: [] };
    return {
      id,
      name: payload.name,
      description: coalesce(payload.description, existing?.description, undefined),
      adapterName: payload.adapterName,
      clientId: coalesce(payload.clientId, existing?.clientId, undefined),
      env: coalesce(payload.env, existing?.env, undefined),
      credentials: coalesce(payload.credentials, existing?.credentials, undefined),
      cwd: coalesce(payload.cwd, existing?.cwd, undefined),
      approvalPolicy: coalesce(payload.approvalPolicy, existing?.approvalPolicy, 'always-ask'),
      nativeTools: coalesce(payload.nativeTools, existing?.nativeTools, emptySelection),
      registryTools: coalesce(payload.registryTools, existing?.registryTools, emptySelection),
      skills: coalesce(payload.skills, existing?.skills, undefined),
      toolCapabilityMap: payload.toolCapabilityMap ?? existing?.toolCapabilityMap,
      capabilityOverrides: payload.capabilityOverrides ?? existing?.capabilityOverrides,
      toolApprovalOverrides: payload.toolApprovalOverrides ?? existing?.toolApprovalOverrides,
      // Preserve persisted flags when omitted by schema-driven editors.
      isDefault: coalesce(payload.isDefault, existing?.isDefault, false),
      enabled: coalesce(payload.enabled, existing?.enabled, true),
    };
  }

  /**
   * Resolves the stable ID for a harness by name and identity discriminator.
   *
   * Uses `clientId` as the discriminator when set; falls back to `adapterName`.
   * This ensures client-scoped and adapter-scoped harnesses share the same ID
   * derivation strategy and are distinguishable by their discriminator.
   *
   * Queries by name only to detect discriminator conflicts: if an existing
   * harness with the same name was created under a different scope, an error
   * is thrown rather than silently creating a duplicate with a new ID.
   * @param name - Harness name
   * @param adapterName - Adapter driver name (used when clientId is absent)
   * @param clientId - Client package identifier (preferred discriminator)
   * @returns Stable harness ID
   */
  private async resolveHarnessId(
    name: string,
    adapterName: string | undefined,
    clientId: string | undefined,
  ): Promise<string> {
    const discriminator = clientId ?? adapterName;
    // Query by name only so we can detect harnesses with the same name but a
    // different scope. Filtering by adapterName/clientId would miss conflicts
    // when the caller changes discriminators between create and update.
    const { harnesses } = await this.bus.request(HarnessStorageSubjects.list, { name });
    const existing = harnesses.find(
      (harness) => harness.name === name && (harness.clientId ?? harness.adapterName) === discriminator,
    );
    if (existing) {
      return existing.id;
    }

    const nameConflict = harnesses.find(
      (harness) => harness.name === name && (harness.clientId ?? harness.adapterName) !== discriminator,
    );
    if (nameConflict) {
      const existingScope = nameConflict.clientId
        ? `client '${nameConflict.clientId}'`
        : `adapter '${nameConflict.adapterName}'`;
      throw new Error(
        `Harness "${name}" already exists with scope ${existingScope}; cannot change scope to ${discriminator ?? '(none)'}`,
      );
    }

    return this.createStableHarnessId(name, discriminator);
  }

  private async loadHarness(input: HarnessLookupInput): Promise<Harness | null> {
    if (input.id) {
      const { harness } = await this.bus.request(HarnessStorageSubjects.get, { id: input.id });
      if (
        harness &&
        (!input.adapterName || harness.adapterName === input.adapterName) &&
        (!input.clientId || harness.clientId === input.clientId)
      ) {
        return harness;
      }

      // If id is provided, treat it as authoritative and never fall back to name.
      return null;
    }

    if (!input.name) {
      return null;
    }

    const { harnesses } = await this.bus.request(HarnessStorageSubjects.list, {
      name: input.name,
      adapterName: input.adapterName,
      clientId: input.clientId,
    });

    if (input.clientId) {
      return harnesses.find((harness) => harness.clientId === input.clientId) ?? null;
    }

    if (input.adapterName) {
      return harnesses.find((harness) => harness.adapterName === input.adapterName) ?? null;
    }

    return harnesses[0] ?? null;
  }

  /**
   * Returns the best available harness for the given adapter or client.
   *
   * Searches by `clientId` first when provided, then falls back to `adapterName`.
   * Within each candidate set, prefers the default-flagged harness, then any enabled harness.
   * At least one of `adapterName` or `clientId` must be provided (enforced by schema).
   * @param adapterName - Adapter driver name; may be omitted when `clientId` is provided
   * @param clientId - Optional client package identifier to search first
   * @returns The resolved harness
   */
  private async getDefaultHarness(adapterName: string | undefined, clientId?: string): Promise<Harness> {
    if (clientId) {
      const { harnesses: clientHarnesses } = await this.bus.request(HarnessStorageSubjects.list, { clientId });
      const defaultClientHarness = clientHarnesses.find((harness) => harness.isDefault && harness.enabled);
      if (defaultClientHarness) {
        return defaultClientHarness;
      }

      const enabledClientHarness = clientHarnesses.find((harness) => harness.enabled);
      if (enabledClientHarness) {
        return enabledClientHarness;
      }
    }

    if (adapterName) {
      const { harnesses } = await this.bus.request(HarnessStorageSubjects.list, { adapterName });
      const defaultHarness = harnesses.find((harness) => harness.isDefault && harness.enabled);

      if (defaultHarness) {
        return defaultHarness;
      }

      const enabledHarness = harnesses.find((harness) => harness.enabled);
      if (enabledHarness) {
        return enabledHarness;
      }
    }

    const context = clientId
      ? adapterName
        ? `client '${clientId}' or adapter '${adapterName}'`
        : `client '${clientId}'`
      : `adapter '${adapterName}'`;
    throw new Error(`No harness available for ${context}`);
  }

  /**
   * Asserts that the resolved harness is compatible with the requested adapter context.
   *
   * Adapter-scoped harnesses (with `adapterName`) must match the requested adapter.
   * Client-scoped harnesses (with `clientId`, no `adapterName`) must match the requesting
   * client when `clientId` is provided by the caller; omitting `clientId` allows any client
   * for backward compatibility.
   * @param harness - The resolved harness to validate
   * @param adapterName - The adapter name from the resolve request
   * @param source - Context label for error messages
   * @param clientId - Optional client identifier from the resolve request
   */
  private assertHarnessAdapterMatch(
    harness: Harness,
    adapterName: string | undefined,
    source: 'persona' | 'profile',
    clientId?: string,
  ): void {
    if (harness.adapterName && adapterName && harness.adapterName !== adapterName) {
      throw new Error(
        `Resolved ${source} harness adapter mismatch: expected "${adapterName}", got "${harness.adapterName}"`,
      );
    }

    // Client-scoped harness: validate clientId when both harness and caller provide one.
    if (harness.clientId && clientId && harness.clientId !== clientId) {
      throw new Error(`Resolved ${source} harness client mismatch: expected "${clientId}", got "${harness.clientId}"`);
    }
  }

  private assertHarnessEnabled(harness: Harness, source: 'persona' | 'profile'): void {
    if (harness.enabled) {
      return;
    }

    throw new Error(`Resolved ${source} harness is disabled: ${harness.id}`);
  }

  /**
   * Validates nativeTools names against the adapter's declared tools.
   *
   * Skips validation when the adapter is not loaded (e.g., during seeding,
   * offline harness editing, or tests without a running adapter).
   * Throws a hard error when the adapter is loaded but a tool name is not found.
   * @param adapterName - The adapter to query for declared tools
   * @param nativeTools - The harness tool selection to validate
   */
  private async validateNativeTools(
    adapterName: string,
    nativeTools: { enabled: string[]; disabled: string[] },
  ): Promise<void> {
    const result = await this.bus.requestOptional(AdapterSubjects.getCapabilities, { adapterName });
    if (!result.handled) {
      // Adapter not loaded — skip validation to allow seeding and offline editing.
      return;
    }

    const declared = new Set(result.data.nativeTools);
    const allRequested = [...nativeTools.enabled, ...nativeTools.disabled];
    const invalid = allRequested.filter((name) => !declared.has(name));

    if (invalid.length > 0) {
      throw new Error(
        `Tool '${invalid[0]}' not found in adapter '${adapterName}' native tools. ` +
          `Declared tools: ${[...declared].join(', ')}`,
      );
    }
  }

  /**
   * Creates a stable deterministic harness ID from a name and identity discriminator.
   *
   * The discriminator is `clientId` when available, otherwise `adapterName`.
   * @param name - Harness name
   * @param discriminator - Identity discriminator (clientId or adapterName)
   * @returns Stable harness ID with `harness-` prefix
   */
  private createStableHarnessId(name: string, discriminator: string | undefined): string {
    const digest = createHash('sha256')
      .update(`${discriminator ?? ''}\0${name}`)
      .digest('hex')
      .slice(0, 24);
    return `harness-${digest}`;
  }

  /**
   * Loads a harness by ID, validates it is compatible with the requested adapter context,
   * and asserts it is enabled.
   * @param harnessId - ID of the harness to resolve
   * @param adapterName - Adapter name from the resolve request
   * @param source - Context label for error messages
   * @param clientId - Optional client identifier from the resolve request
   * @returns The validated harness
   */
  private async resolveAndValidateHarness(
    harnessId: string,
    adapterName: string | undefined,
    source: 'persona' | 'profile',
    clientId?: string,
  ): Promise<Harness> {
    const harness = await this.loadHarness({ id: harnessId });
    if (!harness) {
      const sourceLabel = source === 'persona' ? 'Persona' : 'Profile';
      throw new Error(`${sourceLabel} harness not found: ${harnessId}`);
    }

    this.assertHarnessAdapterMatch(harness, adapterName, source, clientId);
    // Explicit selection does not bypass lifecycle state: disabled harnesses are never resolvable.
    this.assertHarnessEnabled(harness, source);
    return harness;
  }
}
