import { describe, expect, it } from 'bun:test';
import { probeHealth } from '../src/health-probe.js';

describe('probeHealth (Electrobun adapter)', () => {
  it('returns null when no server is running on the port', async () => {
    const result = await probeHealth(59999);
    expect(result).toBeNull();
  });
});
