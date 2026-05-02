import { describe, expect, it } from 'vitest';
import { probeHealth } from '../src/health-probe.js';

describe('probeHealth (Electrobun adapter)', () => {
  it('returns null when no server is running on the port', async () => {
    const result = await probeHealth(59999);
    expect(result).toBeNull();
  });
});
