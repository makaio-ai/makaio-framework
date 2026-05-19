import { describe, it, expect } from 'bun:test';
import type { ExtensionDependency } from '@makaio/contracts';
import type { KernelMakaioExtension } from '../extension/types.js';
import { topoSort } from '../extension/topo-sort.js';

/**
 * Build a structured {@link ExtensionDependency} for test fixtures.
 * @param name - Name of the required extension.
 * @param version - SemVer range required from the dependency.
 * @returns A minimal ExtensionDependency object.
 */
function dep(name: string, version = '>=0.1.0'): ExtensionDependency {
  return { type: 'extension', name, version };
}

/**
 * Minimal package factory for topo-sort unit tests.
 * @param name - Package name.
 * @param dependencies - Optional declared structured dependencies.
 * @param version - Package version.
 */
function makePackage(name: string, dependencies?: ExtensionDependency[], version = '1.0.0'): KernelMakaioExtension {
  return { name, displayName: name, version, ...(dependencies ? { dependencies } : {}) };
}

describe('topoSort', () => {
  it('returns a single package with no dependencies', () => {
    expect(topoSort([makePackage('a')])).toEqual(['a']);
  });

  it('returns packages in dependency-first order', () => {
    const packages = [makePackage('c', [dep('b')]), makePackage('b', [dep('a')]), makePackage('a')];
    expect(topoSort(packages)).toEqual(['a', 'b', 'c']);
  });

  it('handles multiple independent roots', () => {
    const result = topoSort([makePackage('b', [dep('a')]), makePackage('a'), makePackage('c')]);
    // 'a' and 'c' have no deps; 'b' must come after 'a'
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
  });

  it('throws on a circular dependency', () => {
    const packages = [makePackage('x', [dep('y')]), makePackage('y', [dep('x')])];
    expect(() => topoSort(packages)).toThrow(/circular dependency/i);
  });

  it('throws when a declared dependency is not in the loaded set', () => {
    expect(() => topoSort([makePackage('child', [dep('missing-parent')])])).toThrow(
      /missing dependencies: missing-parent/i,
    );
  });

  it('ignores a missing optional dependency when sorting', () => {
    expect(topoSort([makePackage('child', [{ ...dep('optional-parent'), optional: true }])])).toEqual(['child']);
  });

  it('orders an optional dependency before its dependent when present', () => {
    const result = topoSort([
      makePackage('child', [{ ...dep('optional-parent'), optional: true }]),
      makePackage('optional-parent'),
    ]);

    expect(result.indexOf('optional-parent')).toBeLessThan(result.indexOf('child'));
  });

  it('throws when a present dependency version does not satisfy the declared range', () => {
    expect(() => topoSort([makePackage('child', [dep('parent', '>=2.0.0')]), makePackage('parent')])).toThrow(
      /dependency "parent" version 1\.0\.0 does not satisfy >=2\.0\.0/i,
    );
  });

  it('throws when two packages share the same name', () => {
    const packages = [makePackage('dup'), makePackage('dup')];
    expect(() => topoSort(packages)).toThrow(/duplicate package name detected: "dup"/i);
  });
});
