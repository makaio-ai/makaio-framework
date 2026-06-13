import { type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { AvailableAdapter } from '@makaio/services-core/settings';
import { ProviderDefinitionSchema } from '@makaio/contracts';
import type { ExtensionCoordinator } from '@makaio/kernel';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { AdapterConfigStore } from './adapter-config-store.js';
import { AdapterRuntimeRegistry } from './adapter-runtime-registry.js';
import { AdapterProviderConfigService } from './adapter-provider-config-service.js';
import { AdapterBindingService } from './adapter-binding-service.js';
import { AdapterContributionProcessor } from './adapter-contribution-processor.js';
import { AdapterSubsystemSubjects } from './namespace.js';
import type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
import type { LoadedAdapter, AdapterInstance } from './adapter-runtime-types.js';
import { registerProviderStorageFallbackHandlers } from './provider-storage-fallback.js';

/**
 * Constructor options for {@link AdapterSubsystemService}.
 */
export interface AdapterSubsystemServiceOptions {
  /**
   * Bus instance used for handler registration.
   */
  readonly bus: IMakaioBus;
  /**
   * Repository seam for the canonical file-backed config tree.
   */
  readonly configRepository: IAdapterConfigRepository;
  /**
   * Extension coordinator forwarded to {@link AdapterContributionProcessor}.
   *
   * The processor uses the coordinator to call `registerContributionProcessor`
   * when its `register()` method is invoked. Registration itself is performed
   * by the composition root before `coordinator.startAll()`.
   */
  readonly coordinator: ExtensionCoordinator;
  /**
   * Stable machine identifier used for deterministic adapter ID derivation.
   */
  readonly machineId: string;
  /**
   * Platform-provided defaults forwarded to adapter factories.
   */
  readonly platformDefaults: PlatformDefaults;
}

/**
 * File-backed adapter subsystem service.
 *
 * Loads the canonical `.makaio/provider-configs` and `.makaio/adapters`
 * trees into an in-memory snapshot during init, then serves all reads and
 * writes from that snapshot while keeping raw file state separate from the
 * bus-safe read models.
 *
 * Adapter packages are processed incrementally as they become `active` via
 * an awaited {@link ContributionProcessor} registered with the
 * {@link ExtensionCoordinator}. When a package declares adapters, each
 * adapter contribution is processed synchronously within `startAll()` before
 * the coordinator advances to the next package, ensuring post-coordinator boot
 * phases run only after adapter contributions are registered and enabled
 * adapters have been initialized:
 * 1. Registered in the file-backed config (created with `enabled: false` when absent)
 * 2. Stored in the in-memory loaded-adapter registry
 * 3. Published via `adapterSubsystem.adapter.registered`
 * 4. Initialized (factory call) when enabled in settings
 */
export class AdapterSubsystemService extends BaseService {
  private readonly configStore: AdapterConfigStore;
  private readonly registry: AdapterRuntimeRegistry;
  private readonly providerConfigService: AdapterProviderConfigService;
  private readonly bindingService: AdapterBindingService;
  private readonly contributionProcessor: AdapterContributionProcessor;

  /**
   * Create a new adapter subsystem service.
   * @param options - Service dependencies provided by the package factory.
   */
  public constructor(options: AdapterSubsystemServiceOptions) {
    super(options.bus);

    this.configStore = new AdapterConfigStore({
      configRepository: options.configRepository,
      bus: options.bus,
    });

    this.registry = new AdapterRuntimeRegistry({
      bus: options.bus,
      machineId: options.machineId,
    });

    this.providerConfigService = new AdapterProviderConfigService({
      configStore: this.configStore,
      bus: options.bus,
    });

    this.bindingService = new AdapterBindingService({
      configStore: this.configStore,
      bus: options.bus,
    });

    this.contributionProcessor = new AdapterContributionProcessor({
      configStore: this.configStore,
      registry: this.registry,
      coordinator: options.coordinator,
      machineId: options.machineId,
      platformDefaults: options.platformDefaults,
    });
  }

  /**
   * Initialize the service by loading the canonical snapshot and registering
   * adapter subsystem bus handlers.
   *
   * Contribution-processor registration is performed by the composition root
   * (via {@link createAdapterSubsystemContributionProcessor}) before
   * `coordinator.startAll()`, so the service does not self-register here.
   */
  protected override async onInit(): Promise<void> {
    await this.configStore.loadSnapshot();
    this.configStore.registerListeners((fn) => this.addCleanup(fn));
    this.registerBusHandlers();
    await this.bus.emit(AdapterSubsystemSubjects.ready, {});
  }

  private registerBusHandlers(): void {
    this.addCleanup(registerProviderStorageFallbackHandlers(this.bus, () => this.registry.getLoadedAdapters()));
    this.registerReadHandlers();
    this.registerMutationHandlers();
  }

  private registerReadHandlers(): void {
    this.registerHandler(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: this.configStore.getAdapterConfig(ctx.payload.name) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listAdapterConfigs, (ctx) => {
      ctx.setResult({ configs: this.configStore.listAdapterConfigs() });
    });
    this.registerHandler(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
      ctx.setResult({ config: this.configStore.getProviderConfig(ctx.payload.id) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      ctx.setResult({ configs: this.configStore.listProviderConfigs(ctx.payload.enabled) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listProviderConfigsByDefinition, (ctx) => {
      ctx.setResult({ configs: this.configStore.listProviderConfigsByDefinition(ctx.payload.definitionId) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listBindings, (ctx) => {
      ctx.setResult({ bindings: this.configStore.listBindings(ctx.payload.adapterName) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
      ctx.setResult({ bindings: this.configStore.listBindingsByConfig(ctx.payload.providerConfigId) });
    });
    this.registerHandler(AdapterSubsystemSubjects.getDefaultBinding, (ctx) => {
      ctx.setResult({ binding: this.configStore.getDefaultBinding(ctx.payload.adapterName) });
    });
    this.registerHandler(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, (ctx) => {
      ctx.setResult({
        config: this.configStore.findConfigForDefinitionAndAdapter(ctx.payload.definitionId, ctx.payload.adapterName),
      });
    });
    this.registerHandler(AdapterSubsystemSubjects.buildProviderContext, async (ctx) => {
      ctx.setResult({ context: await this.configStore.buildProviderContext(ctx.payload.providerConfigId) });
    });
    this.registerHandler(AdapterSubsystemSubjects.listAdapters, async (ctx) => {
      ctx.setResult({ adapters: await this.configStore.buildEffectiveAdapters() });
    });
    this.registerHandler(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      const adapter = this.registry.getLoadedAdapters().find((a) => a.name === ctx.payload.adapterName);
      const definitions = (adapter?.providers ?? []).map((p) => ProviderDefinitionSchema.parse(p.definition));
      ctx.setResult({ definitions });
    });
    this.registerHandler(AdapterSubsystemSubjects.ensureReady, (ctx) => {
      ctx.setResult({ ready: true });
    });
  }

  private registerMutationHandlers(): void {
    this.registerHandler(AdapterSubsystemSubjects.createProviderConfig, async (ctx) => {
      ctx.setResult(await this.providerConfigService.createProviderConfig(ctx.payload));
    });
    this.registerHandler(AdapterSubsystemSubjects.updateProviderConfig, async (ctx) => {
      ctx.setResult(await this.providerConfigService.updateProviderConfig(ctx.payload.id, ctx.payload.patch));
    });
    this.registerHandler(AdapterSubsystemSubjects.setProviderConfigCredentialRefs, async (ctx) => {
      ctx.setResult(
        await this.providerConfigService.setProviderConfigCredentialRefs(ctx.payload.id, ctx.payload.credentialRefs),
      );
    });
    this.registerHandler(AdapterSubsystemSubjects.deleteProviderConfig, async (ctx) => {
      ctx.setResult(await this.providerConfigService.deleteProviderConfig(ctx.payload.id));
    });
    this.registerHandler(AdapterSubsystemSubjects.setDefaultProviderConfig, async (ctx) => {
      ctx.setResult(await this.providerConfigService.setDefaultProviderConfig(ctx.payload.id));
    });
    this.registerHandler(AdapterSubsystemSubjects.setModelFilterMode, async (ctx) => {
      ctx.setResult(
        await this.providerConfigService.setModelFilterMode(
          ctx.payload.id,
          ctx.payload.modelFilterMode,
          ctx.payload.preferredModel,
        ),
      );
    });
    this.registerHandler(AdapterSubsystemSubjects.setAdapterConfig, async (ctx) => {
      ctx.setResult(await this.configStore.setAdapterConfig(ctx.payload.name, ctx.payload.patch));
    });
    this.registerHandler(AdapterSubsystemSubjects.setAdapterEnabled, async (ctx) => {
      await this.configStore.setAdapterEnabled(ctx.payload.name, ctx.payload.enabled);
      ctx.setResult({ success: true });
    });
    this.registerHandler(AdapterSubsystemSubjects.bind, async (ctx) => {
      ctx.setResult({ binding: await this.bindingService.bind(ctx.payload.adapterName, ctx.payload.providerConfigId) });
    });
    this.registerHandler(AdapterSubsystemSubjects.unbind, async (ctx) => {
      await this.bindingService.unbind(ctx.payload.adapterName, ctx.payload.providerConfigId);
      ctx.setResult({});
    });
    this.registerHandler(AdapterSubsystemSubjects.setDefaultBinding, async (ctx) => {
      await this.bindingService.setDefaultBinding(ctx.payload.adapterName, ctx.payload.providerConfigId);
      ctx.setResult({});
    });
  }

  /**
   * Shut down adapter instances and clear in-memory state on destroy.
   */
  protected override async onDestroy(): Promise<void> {
    await this.registry.shutdownAll();
    this.configStore.clear();
  }

  // ---------------------------------------------------------------------------
  // Public accessor API (lazy reads for runtime handlers)
  // ---------------------------------------------------------------------------

  /**
   * Return the live loaded-adapter list, keyed by adapter name.
   *
   * Callers must read at request time (lazy), not cache the result at
   * registration time, because adapters are loaded incrementally.
   * @returns Readonly array of all currently loaded adapter definitions.
   */
  public getLoadedAdapters(): readonly LoadedAdapter[] {
    return this.registry.getLoadedAdapters();
  }

  /**
   * Return the live adapter-instance map.
   *
   * Callers must read at request time (lazy), not cache the result at
   * registration time, because instances are created incrementally.
   * @returns Readonly map of adapter ID to live adapter instance.
   */
  public getAdapterInstances(): ReadonlyMap<string, AdapterInstance> {
    return this.registry.getAdapterInstances();
  }

  /**
   * Return settings-facing available-adapter list derived from loaded adapters.
   * @returns Readonly list of adapter metadata for the settings UI.
   */
  public getSettingsAvailableAdapters(): readonly AvailableAdapter[] {
    return this.registry.getSettingsAvailableAdapters();
  }

  /**
   * Process adapter contributions for one active extension package.
   *
   * Delegates to {@link AdapterContributionProcessor.onPackageActivated}.
   * Called by the composition-root contribution processor registered before
   * `coordinator.startAll()`.
   * @param packageName - Package that transitioned to active.
   * @param pkg - Extension manifest.
   * @param ctx - Per-extension context.
   */
  public async processAdapterContributions(
    packageName: string,
    pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> {
    await this.contributionProcessor.onPackageActivated(packageName, pkg, ctx);
  }

  /**
   * Stop adapter contributions for one stopped extension package.
   *
   * Delegates to {@link AdapterContributionProcessor.onPackageStopped}.
   * Called by the composition-root contribution processor registered before
   * `coordinator.startAll()`.
   * @param packageName - Package that stopped or was disabled.
   */
  public async stopAdapterContributions(packageName: string): Promise<void> {
    await this.contributionProcessor.onPackageStopped(packageName);
  }
}
