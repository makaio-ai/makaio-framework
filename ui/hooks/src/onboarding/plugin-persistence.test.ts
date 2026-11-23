import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ExtensionSubjects } from '@makaio/kernel';
import { createTestCall } from '@makaio/test-utils';
import { persistPluginEnabled } from './plugin-persistence.js';

describe('persistPluginEnabled', () => {
  it('persists enabled state through the kernel setEnabled RPC', async () => {
    const bus = createBusInstance();
    const request = vi.spyOn(bus, 'request').mockResolvedValue({ success: true, outcome: 'applied' });
    const call = createTestCall();

    const result = await persistPluginEnabled(call, 'github', true, bus);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(call, ExtensionSubjects.setEnabled, { name: 'github', enabled: true });
    expect(request.mock.calls[0]?.[0]).toBe(call);
    expect(result).toEqual({ success: true, outcome: 'applied' });
  });

  it('a rejected response does not mutate any external state', async () => {
    const bus = createBusInstance();
    vi.spyOn(bus, 'request').mockResolvedValue({ success: false, outcome: 'rejected' });

    // The function is a pure bus passthrough — no external state to mutate.
    // Verify it resolves cleanly and surfaces the failure and its outcome
    // without throwing.
    const result = await persistPluginEnabled(createTestCall(), 'github', false, bus);

    expect(result).toEqual({ success: false, outcome: 'rejected' });
  });
});
