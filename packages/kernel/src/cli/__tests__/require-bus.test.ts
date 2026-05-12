import { describe, it, expect } from 'vitest';
import { createMockBus } from '@makaio/test-utils';
import { requireBus } from '../types.js';
import type { CommandContext } from '../types.js';

describe('requireBus', () => {
  it('returns the bus when it is non-null', () => {
    const { bus } = createMockBus();
    const ctx = { bus } as CommandContext<unknown>;
    expect(requireBus(ctx)).toBe(bus);
  });

  it('throws when the bus is null', () => {
    const ctx = { bus: null } as CommandContext<unknown>;
    expect(() => requireBus(ctx)).toThrow('This command requires a running Makaio server.');
  });

  it('works with interactive handler contexts', () => {
    const { bus } = createMockBus();
    expect(requireBus({ bus })).toBe(bus);
    expect(() => requireBus({ bus: null })).toThrow('This command requires a running Makaio server.');
  });
});
