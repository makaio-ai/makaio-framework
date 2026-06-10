import { describe, expect, it } from 'vitest';
import {
  isFrameworkOwnedImport,
  rewriteFrameworkImportSpecifier,
  rewriteFrameworkImportsInText,
} from '../framework-import-map.js';

describe('framework import map', () => {
  it('rewrites root framework-owned packages to umbrella subpaths', () => {
    expect(rewriteFrameworkImportSpecifier('@makaio/bus-core')).toBe('@makaio/framework/bus');
    expect(rewriteFrameworkImportSpecifier('@makaio/contracts')).toBe('@makaio/framework/contracts');
    expect(rewriteFrameworkImportSpecifier('@makaio/ai-adapters-core')).toBe('@makaio/framework/adapters');
    expect(rewriteFrameworkImportSpecifier('@makaio/subsystem-client')).toBe('@makaio/framework/clients');
  });

  it('rewrites bundled runtime and subsystem packages to umbrella subpaths', () => {
    expect(rewriteFrameworkImportSpecifier('@makaio/runtime-node')).toBe('@makaio/framework/runtime-node');
    expect(rewriteFrameworkImportSpecifier('@makaio/subsystem-workflow-engine')).toBe(
      '@makaio/framework/workflow-engine',
    );
  });

  it('rewrites framework-owned package subpaths', () => {
    expect(rewriteFrameworkImportSpecifier('@makaio/contracts/extension')).toBe(
      '@makaio/framework/contracts/extension',
    );
    expect(rewriteFrameworkImportSpecifier('@makaio/ai-adapters-core/config')).toBe(
      '@makaio/framework/adapters/config',
    );
  });

  it('prefers the longer package name when names share a prefix', () => {
    // @makaio/ai-adapters-stream-session is more specific than @makaio/ai-adapters-core
    expect(rewriteFrameworkImportSpecifier('@makaio/ai-adapters-stream-session')).toBe(
      '@makaio/framework/adapters/stream-session',
    );
    expect(rewriteFrameworkImportSpecifier('@makaio/ai-adapters-stream-session/testing')).toBe(
      '@makaio/framework/adapters/stream-session/testing',
    );
  });

  it('does not rewrite adapter-specific provider packages', () => {
    expect(isFrameworkOwnedImport('@makaio/provider-openai')).toBe(false);
    expect(rewriteFrameworkImportSpecifier('@makaio/provider-openai')).toBeUndefined();
  });

  it('does not rewrite non-makaio packages', () => {
    expect(rewriteFrameworkImportSpecifier('openai')).toBeUndefined();
    expect(rewriteFrameworkImportSpecifier('zod')).toBeUndefined();
  });

  it('does not rewrite @makaio/framework umbrella subpath imports', () => {
    // The umbrella package itself is not a workspace package entry in the map
    expect(rewriteFrameworkImportSpecifier('@makaio/framework/bus')).toBeUndefined();
    expect(isFrameworkOwnedImport('@makaio/framework/adapters')).toBe(false);
  });

  it('rewrites declaration file text', () => {
    const input = `import type { IMakaioBus } from '@makaio/bus-core';\nimport { z } from 'zod';`;
    const output = rewriteFrameworkImportsInText(input);
    expect(output).toContain("'@makaio/framework/bus'");
    expect(output).toContain("'zod'");
    expect(output).not.toContain('@makaio/bus-core');
  });

  it('rewrites subpath imports in declaration file text', () => {
    const input = `export type { Foo } from '@makaio/contracts/extension';`;
    const output = rewriteFrameworkImportsInText(input);
    expect(output).toContain("'@makaio/framework/contracts/extension'");
    expect(output).not.toContain('@makaio/contracts');
  });

  it('handles double-quoted imports in text rewriting', () => {
    const input = `import type { Bar } from "@makaio/bus-core";`;
    const output = rewriteFrameworkImportsInText(input);
    expect(output).toContain('"@makaio/framework/bus"');
    expect(output).not.toContain('@makaio/bus-core');
  });

  it('returns unchanged text when no framework imports are present', () => {
    const input = `import { z } from 'zod';\nimport type { Foo } from './local.js';`;
    expect(rewriteFrameworkImportsInText(input)).toBe(input);
  });
});
