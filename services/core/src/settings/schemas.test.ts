import { describe, expect, it } from 'vitest';
import { AdapterInfoSchema } from './schemas.js';

describe('AdapterInfoSchema', () => {
  it('requires the canonical readiness derived by the adapter subsystem', () => {
    expect(
      AdapterInfoSchema.safeParse({
        adapterName: 'claude-code',
        displayName: 'Claude Code',
        enabled: true,
        configCount: 1,
        supportsLogImport: false,
      }).success,
    ).toBe(false);
  });
});
