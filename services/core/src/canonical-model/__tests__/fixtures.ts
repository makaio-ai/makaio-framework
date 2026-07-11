import type { ProviderDefinition, ProviderAIModel } from '@makaio/contracts';
import { type BindingRecord } from '../../adapter-subsystem/index.js';

/**
 * Builds a minimal binding record for use in tests.
 * @param overrides - Field overrides
 * @returns Binding record
 */
export function makeBinding(overrides: Partial<BindingRecord> = {}): BindingRecord {
  return {
    ...overrides,
    adapterName: overrides.adapterName ?? 'anthropic-sdk',
    providerConfigId: overrides.providerConfigId ?? 'config-1',
    isDefault: overrides.isDefault ?? true,
  };
}

/**
 * Builds the ID-only provider-config lookup shape used by the resolver seam.
 * @param overrides - Field overrides
 * @returns Provider config record
 */
export function makeConfigRecord(overrides: Partial<{ readonly id: string }> = {}): { readonly id: string } {
  return {
    id: 'config-1',
    ...overrides,
  };
}

/**
 * Builds a minimal {@link ProviderDefinition} for use in tests.
 * @param overrides - Field overrides
 * @returns Provider definition
 */
export function makeDefinition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'def-1',
    name: 'Anthropic',
    authMethods: [],
    availableModels: [],
    ...overrides,
  };
}

/**
 * Builds a minimal {@link ProviderAIModel} with required fields for use in tests.
 * @param name - Model identifier
 * @param labId - Lab identifier (defaults to 'test-lab')
 * @returns Provider AI model fixture
 */
export function makeModel(name: string, labId = 'test-lab'): ProviderAIModel {
  return { name, contextWindowSize: 200_000, labId };
}
