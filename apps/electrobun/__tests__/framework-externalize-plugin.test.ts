/**
 * Tests for the Electrobun framework externalization re-exports.
 *
 * Specifier rewriting and text-level rewriting are tested comprehensively in
 * `framework/build-tooling/__tests__/framework-import-map.test.ts`. This file
 * covers only `frameworkExternalPackageNames` (genuinely new) and a smoke test
 * confirming the re-exports resolve correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  rewriteToFrameworkSubpath,
  frameworkExternalPackageNames,
  rewriteFrameworkImportsInBundle,
} from '../src/build/framework-externalize-plugin.js';

describe('re-export smoke test', () => {
  it('rewriteToFrameworkSubpath resolves to rewriteFrameworkImportSpecifier', () => {
    expect(rewriteToFrameworkSubpath('@makaio/bus-core')).toBe('@makaio/framework/bus');
    expect(rewriteToFrameworkSubpath('@makaio/host-shared')).toBeUndefined();
  });

  it('rewriteFrameworkImportsInBundle resolves to rewriteFrameworkImportsInText', () => {
    const input = 'import { x } from "@makaio/bus-core";';
    expect(rewriteFrameworkImportsInBundle(input)).toContain('"@makaio/framework/bus"');
  });
});

describe('frameworkExternalPackageNames', () => {
  it('returns all framework public surface package names', () => {
    const names = frameworkExternalPackageNames();
    expect(names).toContain('@makaio/bus-core');
    expect(names).toContain('@makaio/contracts');
    expect(names).toContain('@makaio/utils');
    expect(names).toContain('@makaio/kernel');
    expect(names).toContain('@makaio/services-core');
    expect(names).toContain('@makaio/ui-kernel');
  });

  it('does not include non-framework-surface packages', () => {
    const names = frameworkExternalPackageNames();
    expect(names).not.toContain('@makaio/host-shared');
    expect(names).not.toContain('@makaio/runtime-bun');
    expect(names).not.toContain('@makaio/cli');
  });

  it('deduplicates package names', () => {
    const names = frameworkExternalPackageNames();
    expect(names.length).toBe(new Set(names).size);
  });
});
