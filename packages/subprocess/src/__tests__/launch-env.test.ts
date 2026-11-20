import { describe, expect, it } from 'vitest';
import { mergeEnvironment } from '../launch-env.js';

describe('mergeEnvironment', () => {
  it('removes an inherited entry of another letter case with undefined on win32', () => {
    expect(mergeEnvironment({ Path: 'x', A: '1' }, { PATH: undefined }, 'merge', 'win32')).toEqual({ A: '1' });
  });

  it('replaces an inherited entry of another letter case on win32', () => {
    expect(mergeEnvironment({ Path: 'x' }, { path: 'y' }, 'merge', 'win32')).toEqual({ path: 'y' });
  });

  it('keeps both letter cases on linux', () => {
    expect(mergeEnvironment({ Path: 'x' }, { PATH: 'y' }, 'merge', 'linux')).toEqual({ Path: 'x', PATH: 'y' });
    expect(mergeEnvironment({ Path: 'x' }, { PATH: undefined }, 'merge', 'linux')).toEqual({ Path: 'x' });
  });

  it.each(['win32', 'linux'] as const)('ignores the base in replace mode on %s', (platform) => {
    expect(mergeEnvironment({ Path: 'x', A: '1' }, { B: '2', C: undefined }, 'replace', platform)).toEqual({ B: '2' });
  });

  it('returns the base unchanged without overrides in merge mode', () => {
    expect(mergeEnvironment({ A: '1', B: undefined }, undefined, 'merge', 'linux')).toEqual({ A: '1' });
  });
});
