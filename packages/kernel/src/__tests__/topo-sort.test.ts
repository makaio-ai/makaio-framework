import { describe, it, expect } from 'vitest';
import type { MakaioExtension } from '@makaio/contracts';
import { topoSort } from '../extension/topo-sort.js';

/**
 * Minimal package factory for topo-sort unit tests.
 * @param name - Package name.
 * @param dependencies - Optional declared dependency names.
 */
function makePackage(name: string, dependencies?: string[]): MakaioExtension {
  return { name, displayName: name, ...(dependencies ? { dependencies } : {}) };
}

describe('topoSort', () => {
  it('returns a single package with no dependencies', () => {
    expect(topoSort([makePackage('a')])).toEqual(['a']);
  });

  it('returns packages in dependency-first order', () => {
    const packages = [makePackage('c', ['b']), makePackage('b', ['a']), makePackage('a')];
    expect(topoSort(packages)).toEqual(['a', 'b', 'c']);
  });

  it('handles multiple independent roots', () => {
    const result = topoSort([makePackage('b', ['a']), makePackage('a'), makePackage('c')]);
    // 'a' and 'c' have no deps; 'b' must come after 'a'
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
  });

  it('throws on a circular dependency', () => {
    const packages = [makePackage('x', ['y']), makePackage('y', ['x'])];
    expect(() => topoSort(packages)).toThrow(/circular dependency/i);
  });

  it('throws when a declared dependency is not in the loaded set', () => {
    expect(() => topoSort([makePackage('child', ['missing-parent'])])).toThrow(/missing dependencies: missing-parent/i);
  });

  it('throws when two packages share the same name', () => {
    const packages = [makePackage('dup'), makePackage('dup')];
    expect(() => topoSort(packages)).toThrow(/duplicate package name detected: "dup"/i);
  });
});
