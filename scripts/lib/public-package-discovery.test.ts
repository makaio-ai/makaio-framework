import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { findPublicPackageDirs, readPackageJson } from './public-package-discovery.js';

describe('findPublicPackageDirs', () => {
  it('discovers the public Node runtime package', () => {
    const frameworkRoot = resolve(import.meta.dirname, '..', '..');
    const packageNames = findPublicPackageDirs(frameworkRoot).map((packageDir) => readPackageJson(packageDir).name);

    expect(packageNames).toContain('@makaio/runtime-node');
  });
});
