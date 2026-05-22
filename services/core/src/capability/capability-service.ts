import type { IMakaioBus } from '@makaio/bus-core';
import {
  CapabilitySubjects,
  type ICapabilityProvider,
  type ProviderRegistration,
  type ProviderUnregistration,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';

/**
 * Service managing capability provider registration and discovery.
 *
 * Listens for `capability.register` events from extensions and maintains
 * the registry of providers per capability. Handles generic capability
 * operations (listProviders, validate).
 */
export class CapabilityService extends BaseService {
  private readonly providers = new Map<string, ICapabilityProvider[]>();

  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    // Handle provider registration events
    this.registerHandler(CapabilitySubjects.register, (ctx) => {
      this.handleRegister(ctx.payload as ProviderRegistration);
    });
    this.registerHandler(CapabilitySubjects.unregister, (ctx) => {
      this.handleUnregister(ctx.payload);
    });

    // Handle listProviders requests
    this.registerHandler(CapabilitySubjects.listProviders, (ctx) => {
      const { capabilityId } = ctx.payload;
      const providers = this.getProviders(capabilityId);
      ctx.setResult({
        providers: providers.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          providerKey: p.providerKey,
        })),
      });
    });

    // Handle validate requests
    this.registerHandler(CapabilitySubjects.validate, async (ctx) => {
      const { capabilityId } = ctx.payload;
      const results = await this.validateAll(capabilityId);
      ctx.setResult({ results });
    });
  }

  private handleRegister(registration: ProviderRegistration): void {
    const { capabilityId } = registration;
    // Type safety is enforced by registration helpers, not Zod schema
    const provider = registration.provider as ICapabilityProvider;
    const existing = this.providers.get(capabilityId) ?? [];
    const index = existing.findIndex((p) => p.id === provider.id);

    if (index >= 0) {
      existing[index] = provider;
      return;
    }

    existing.push(provider);
    this.providers.set(capabilityId, existing);
  }

  private handleUnregister(registration: ProviderUnregistration): void {
    this.unregisterProvider(registration.capabilityId, registration.providerId);
  }

  /**
   * Remove a provider from a capability bucket.
   * @param capabilityId - Capability bucket to update
   * @param providerId - Provider identifier to remove
   */
  public unregisterProvider(capabilityId: string, providerId: string): void {
    const existing = this.providers.get(capabilityId);
    if (!existing) return;

    const remaining = existing.filter((provider) => provider.id !== providerId);
    if (remaining.length === 0) {
      this.providers.delete(capabilityId);
      return;
    }

    this.providers.set(capabilityId, remaining);
  }

  public getProviders(capabilityId: string): ICapabilityProvider[] {
    return this.providers.get(capabilityId) ?? [];
  }

  public hasProviders(capabilityId: string): boolean {
    const providers = this.providers.get(capabilityId);
    return providers !== undefined && providers.length > 0;
  }

  public getCapabilities(): string[] {
    return [...this.providers.keys()];
  }

  public async validateAll(capabilityId: string): Promise<Array<{ id: string; valid: boolean; error?: string }>> {
    const providers = this.getProviders(capabilityId);
    return Promise.all(
      providers.map(async (provider) => {
        if (provider.validate) {
          const result = await provider.validate();
          return { id: provider.id, ...result };
        }
        return { id: provider.id, valid: true };
      }),
    );
  }

  protected onDestroy(): void {
    this.providers.clear();
  }

  public clear(): void {
    this.providers.clear();
  }
}
