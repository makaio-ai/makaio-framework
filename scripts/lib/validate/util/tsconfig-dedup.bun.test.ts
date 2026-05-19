import { describe, expect, it } from 'bun:test';
import { createOptionsFingerprint } from './tsconfig-dedup.js';

describe('createOptionsFingerprint', () => {
  it('differs for identical options in different config directories', () => {
    const options = {
      strict: true,
      types: ['node'],
    };

    const a = createOptionsFingerprint(options, '/repo/host/apps/mobile/tsconfig.json');
    const b = createOptionsFingerprint(options, '/repo/host/services/session/tsconfig.json');

    expect(a).not.toBe(b);
  });

  it('matches for same options in same config directory', () => {
    const options = {
      strict: true,
      types: ['node', 'vite/client'],
    };

    const a = createOptionsFingerprint(options, '/repo/host/web/app/tsconfig.json');
    const b = createOptionsFingerprint(options, '/repo/host/web/app/tsconfig.json');

    expect(a).toBe(b);
  });
});
