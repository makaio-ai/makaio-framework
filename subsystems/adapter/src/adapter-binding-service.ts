import type { IMakaioBus } from '@makaio/bus-core';
import type { BindingRecord } from '@makaio/services-core/adapter-subsystem';
import { toBindingRecords } from './adapter-config-derived-state.js';
import { hasEnabledBinding, isProviderConfigEnabled, promoteEnabledBindingDefault } from './binding-defaults.js';
import { AdapterSubsystemSubjects } from './namespace.js';
import type { AdapterConfigStore } from './adapter-config-store.js';

/**
 * Constructor options for {@link AdapterBindingService}.
 */
export interface AdapterBindingServiceOptions {
  readonly configStore: AdapterConfigStore;
  readonly bus: IMakaioBus;
}

/**
 * Owns the adapter/provider binding policy — creating, removing, and
 * promoting default bindings.
 *
 * All snapshot mutations are delegated to {@link AdapterConfigStore} and all
 * resulting state changes are broadcast on the bus.
 */
export class AdapterBindingService {
  private readonly configStore: AdapterConfigStore;
  private readonly bus: IMakaioBus;

  /**
   * Create a new adapter binding service.
   * @param options - Dependencies required by the service.
   */
  public constructor(options: AdapterBindingServiceOptions) {
    this.configStore = options.configStore;
    this.bus = options.bus;
  }

  /**
   * Bind a provider config to an adapter.
   *
   * If the binding already exists, returns the existing record without
   * emitting an event. If the provider config is enabled and no enabled
   * binding exists yet, the new binding becomes the default.
   * @param adapterName - Adapter name.
   * @param providerConfigId - Provider config ID.
   * @returns The resulting binding record.
   */
  public async bind(adapterName: string, providerConfigId: string): Promise<BindingRecord> {
    let binding: BindingRecord | undefined;
    let created = false;

    await this.configStore.commitSnapshotMutation((nextSnapshot) => {
      const providerConfig = nextSnapshot.providerConfigs.get(providerConfigId);
      if (!providerConfig) {
        throw new Error(`Provider config not found: ${providerConfigId}`);
      }
      const existing = nextSnapshot.adapters.get(adapterName);
      if (!existing) {
        throw new Error(`Adapter config not found: ${adapterName}`);
      }
      const currentBindings = toBindingRecords(adapterName, existing.bindings);
      const alreadyBound = currentBindings.find((current) => current.providerConfigId === providerConfigId);
      if (alreadyBound) {
        binding = { ...alreadyBound };
        return;
      }
      created = true;
      binding = {
        adapterName,
        providerConfigId,
        isDefault:
          (providerConfig.enabled ?? true) && !hasEnabledBinding(currentBindings, nextSnapshot.providerConfigs),
      };
      const nextBindings = [...currentBindings, binding];
      nextSnapshot.adapters.set(adapterName, {
        ...existing,
        bindings: nextBindings.map(({ adapterName: _adapterName, ...rest }) => rest),
      });
    });

    if (!binding) {
      throw new Error(`Binding could not be loaded after bind: ${adapterName}/${providerConfigId}`);
    }
    if (created) {
      await this.bus.emit(AdapterSubsystemSubjects.binding.created, binding);
    }
    return binding;
  }

  /**
   * Unbind a provider config from an adapter.
   *
   * If the removed binding was the default, the first remaining enabled
   * binding is promoted to default and a `defaultChanged` event is emitted.
   * No-ops silently when the adapter or binding does not exist.
   * @param adapterName - Adapter name.
   * @param providerConfigId - Provider config ID.
   */
  public async unbind(adapterName: string, providerConfigId: string): Promise<void> {
    let promoted: BindingRecord | undefined;
    let removed = false;

    await this.configStore.commitSnapshotMutation((nextSnapshot) => {
      const existing = nextSnapshot.adapters.get(adapterName);
      if (!existing) {
        return;
      }
      const currentBindings = toBindingRecords(adapterName, existing.bindings);
      const targetIndex = currentBindings.findIndex((binding) => binding.providerConfigId === providerConfigId);
      if (targetIndex === -1) {
        return;
      }
      const [removedBinding] = currentBindings.splice(targetIndex, 1);
      removed = true;
      if (removedBinding?.isDefault && currentBindings.length > 0) {
        const result = promoteEnabledBindingDefault(currentBindings, nextSnapshot.providerConfigs);
        promoted = result.promoted;
        currentBindings.splice(0, currentBindings.length, ...result.bindings);
      }
      nextSnapshot.adapters.set(adapterName, {
        ...existing,
        bindings: currentBindings.map(({ adapterName: _adapterName, ...rest }) => rest),
      });
    });

    if (!removed) return;
    await this.bus.emit(AdapterSubsystemSubjects.binding.deleted, { adapterName, providerConfigId });
    if (promoted) {
      await this.bus.emit(AdapterSubsystemSubjects.binding.defaultChanged, {
        adapterName,
        providerConfigId: promoted.providerConfigId,
      });
    }
  }

  /**
   * Promote a bound provider config to the default for its adapter.
   *
   * Throws when the adapter, the binding, or the provider config does not
   * exist, or when the provider config is disabled. No-ops when the binding
   * is already the default.
   * @param adapterName - Adapter name.
   * @param providerConfigId - Provider config ID to promote.
   */
  public async setDefaultBinding(adapterName: string, providerConfigId: string): Promise<void> {
    let changed = false;

    await this.configStore.commitSnapshotMutation((nextSnapshot) => {
      const existing = nextSnapshot.adapters.get(adapterName);
      if (!existing) {
        throw new Error(`Adapter config not found: ${adapterName}`);
      }
      const currentBindings = toBindingRecords(adapterName, existing.bindings);
      const target = currentBindings.find((binding) => binding.providerConfigId === providerConfigId);
      if (!target) {
        throw new Error(`Binding not found for adapter ${adapterName} and provider config ${providerConfigId}`);
      }
      if (!isProviderConfigEnabled(nextSnapshot.providerConfigs, target.providerConfigId)) {
        throw new Error(`Disabled provider config cannot be default binding: ${providerConfigId}`);
      }
      if (target.isDefault) {
        return;
      }
      changed = true;
      nextSnapshot.adapters.set(adapterName, {
        ...existing,
        bindings: currentBindings.map(({ adapterName: _adapterName, ...rest }) => ({
          ...rest,
          isDefault: rest.providerConfigId === providerConfigId,
        })),
      });
    });

    if (!changed) return;
    await this.bus.emit(AdapterSubsystemSubjects.binding.defaultChanged, {
      adapterName,
      providerConfigId,
    });
  }
}
