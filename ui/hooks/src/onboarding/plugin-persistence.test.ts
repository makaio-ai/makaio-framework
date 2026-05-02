import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ExtensionConfigStorageSubjects } from '@makaio/services-core/settings/storage/extension-configs/namespace';
import { persistPluginEnabled, type PersistedExtensionConfigEntry } from './plugin-persistence.js';

interface ExtensionConfigSetEnabledPayload {
  enabled: boolean;
  extensionName: string;
  scope: 'default';
}

describe('persistPluginEnabled', () => {
  it('persists enabled state through the dedicated enabled-only RPC', async () => {
    const bus = createBusInstance();
    const request = vi.spyOn(bus, 'request').mockResolvedValue({ id: 'stored-config-id' });
    const cache = new Map<string, PersistedExtensionConfigEntry>();

    const result = await persistPluginEnabled('github', true, cache, bus);

    expect(request).toHaveBeenCalledTimes(1);
    const [subject, payload] = request.mock.calls[0] as [unknown, ExtensionConfigSetEnabledPayload];
    expect(subject).toBe(ExtensionConfigStorageSubjects.setEnabled);
    expect(payload).toEqual({
      enabled: true,
      extensionName: 'github',
      scope: 'default',
    });
    expect(result).toEqual({ id: 'stored-config-id' });
    expect(cache.get('github')).toEqual({
      id: 'stored-config-id',
      config: undefined,
    });
  });

  it('preserves cached config blobs while refreshing the canonical row id', async () => {
    const bus = createBusInstance();
    const request = vi.spyOn(bus, 'request').mockResolvedValue({ id: 'config-row-1' });
    const cache = new Map<string, PersistedExtensionConfigEntry>([
      [
        'github',
        {
          id: 'config-row-1',
          config: { enabled: false, nested: { retries: 3 } },
        },
      ],
    ]);

    await persistPluginEnabled('github', false, cache, bus);

    expect(request).toHaveBeenCalledTimes(1);
    const [subject, payload] = request.mock.calls[0] as [unknown, ExtensionConfigSetEnabledPayload];
    expect(subject).toBe(ExtensionConfigStorageSubjects.setEnabled);
    expect(payload).toEqual({
      enabled: false,
      extensionName: 'github',
      scope: 'default',
    });
    expect(cache.get('github')).toEqual({
      id: 'config-row-1',
      config: { enabled: false, nested: { retries: 3 } },
    });
  });
});
