/**
 * Variant build smoke tests.
 *
 * Verifies the build system produces correct variant artifacts and that
 * `electrobun.config.ts` resolves variant metadata properly.
 *
 * Two sections:
 * - **Fast** (always runs): pure logic assertions — no external tools, no I/O.
 *   Validates package.json script declarations, JSON serialization of
 *   `variant.json`, and renderer-config derivation from production helpers.
 * - **Slow** (CI_FULL only): full `package:base` and `package:cef` build
 *   executions that require the Electrobun CLI and take several minutes.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import type { VariantConfig } from '../src/variant-config.js';
import { resolveVariantConfig, resolveVariantRendererConfig } from '../src/variant-config.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the electrobun app's `package.json`.
 * @returns Parsed package.json object.
 */
function readPackageJson(): { scripts: Record<string, string> } {
  const raw = readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8');
  return JSON.parse(raw) as { scripts: Record<string, string> };
}

/**
 * Serialize a {@link VariantConfig} exactly as `build.ts` writes `variant.json`.
 *
 * Replicates: `JSON.stringify(variantConfig, null, 2) + '\n'`
 * @param config - The resolved variant config to serialize.
 * @returns The exact string written by the build script.
 */
function serializeVariantJson(config: VariantConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Fast section — always runs, no external tools required
// ---------------------------------------------------------------------------

describe('variant build smoke — fast', () => {
  describe('package.json script declarations', () => {
    it('defines a package:base script', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:base']).toBeDefined();
    });

    it('defines a package:cef script', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:cef']).toBeDefined();
    });

    it('package:base sets MAKAIO_VARIANT=base', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:base']).toContain('MAKAIO_VARIANT=base');
    });

    it('package:cef sets MAKAIO_VARIANT=cef', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:cef']).toContain('MAKAIO_VARIANT=cef');
    });

    it('package:base invokes electrobun build with the stable env flag', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:base']).toContain('electrobun build');
      expect(scripts['package:base']).toContain('--env=stable');
    });

    it('package:cef invokes electrobun build with the stable env flag', () => {
      const { scripts } = readPackageJson();
      expect(scripts['package:cef']).toContain('electrobun build');
      expect(scripts['package:cef']).toContain('--env=stable');
    });

    it('dev uses Electrobun source-dev without prebuilding dist/index.js', () => {
      const { scripts } = readPackageJson();
      expect(scripts['dev']).toContain('MAKAIO_ELECTROBUN_SOURCE_DEV=1');
      expect(scripts['dev']).toContain('NODE_ENV=development');
      expect(scripts['dev']).toContain('electrobun dev');
      expect(scripts['dev']).not.toContain('build.ts');
    });

    it('dev:watch uses the same source-dev path with watch enabled', () => {
      const { scripts } = readPackageJson();
      expect(scripts['dev:watch']).toContain('MAKAIO_ELECTROBUN_SOURCE_DEV=1');
      expect(scripts['dev:watch']).toContain('NODE_ENV=development');
      expect(scripts['dev:watch']).toContain('electrobun dev --watch');
      expect(scripts['dev:watch']).not.toContain('build.ts');
    });
  });

  describe('variant.json serialization contract', () => {
    it('base variant.json has the expected JSON content', () => {
      const config = resolveVariantConfig('base');
      const serialized = serializeVariantJson(config);
      const parsed: VariantConfig = JSON.parse(serialized);
      expect(parsed).toEqual({
        variant: 'base',
        releaseTrack: 'stable',
        electrobunBuildEnv: 'stable',
        bundleCEF: false,
        defaultRenderer: 'native',
        buildFolder: 'build/base-stable',
        artifactFolder: 'artifacts/base-stable',
      });
    });

    it('cef variant.json has the expected JSON content', () => {
      const config = resolveVariantConfig('cef');
      const serialized = serializeVariantJson(config);
      const parsed: VariantConfig = JSON.parse(serialized);
      expect(parsed).toEqual({
        variant: 'cef',
        releaseTrack: 'stable',
        electrobunBuildEnv: 'stable',
        bundleCEF: true,
        defaultRenderer: 'cef',
        buildFolder: 'build/cef-stable',
        artifactFolder: 'artifacts/cef-stable',
      });
    });

    it('variant.json is terminated with a trailing newline', () => {
      const config = resolveVariantConfig('base');
      expect(serializeVariantJson(config)).toMatch(/\n$/);
    });

    it('variant.json is pretty-printed with 2-space indentation', () => {
      const config = resolveVariantConfig('base');
      const serialized = serializeVariantJson(config);
      // Verify `JSON.stringify(_, null, 2)` indentation is present
      expect(serialized).toContain('  "variant"');
    });
  });

  describe('electrobun.config.ts renderer-config derivation', () => {
    it('base variant produces bundleCEF=false and defaultRenderer=native', () => {
      const config = resolveVariantConfig('base');
      const rendererConfig = resolveVariantRendererConfig(config);
      expect(rendererConfig).toEqual({
        bundleCEF: false,
        defaultRenderer: 'native',
      });
    });

    it('cef variant produces bundleCEF=true and defaultRenderer=cef', () => {
      const config = resolveVariantConfig('cef');
      const rendererConfig = resolveVariantRendererConfig(config);
      expect(rendererConfig).toEqual({
        bundleCEF: true,
        defaultRenderer: 'cef',
      });
    });

    it('base and cef renderer configs differ on all fields', () => {
      const base = resolveVariantRendererConfig(resolveVariantConfig('base'));
      const cef = resolveVariantRendererConfig(resolveVariantConfig('cef'));
      expect(base.bundleCEF).not.toBe(cef.bundleCEF);
      expect(base.defaultRenderer).not.toBe(cef.defaultRenderer);
    });
  });
});

// ---------------------------------------------------------------------------
// Slow section — CI_FULL only (requires Electrobun CLI, takes minutes)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env['CI_FULL'])(
  'variant build smoke — full package builds (CI_FULL)',
  { timeout: 600_000 },
  () => {
    /**
     * Run a yarn workspace script and assert it exits cleanly.
     * @param script - The workspace script name to run (e.g. `package:base`).
     */
    function runPackageScript(script: string): void {
      execFileSync('yarn', ['workspace', '@makaio/electrobun', script], {
        cwd: WORKSPACE_ROOT,
        stdio: 'inherit',
        timeout: 540_000,
      });
    }

    /**
     * Read `dist/variant.json` and return the parsed config.
     * @returns Parsed {@link VariantConfig} from the dist directory.
     */
    function readDistVariantJson(): VariantConfig {
      const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
      return JSON.parse(raw) as VariantConfig;
    }

    it('package:base produces dist/variant.json with the base variant', () => {
      runPackageScript('package:base');
      expect(readDistVariantJson()).toEqual({
        variant: 'base',
        releaseTrack: 'stable',
        electrobunBuildEnv: 'stable',
        bundleCEF: false,
        defaultRenderer: 'native',
        buildFolder: 'build/base-stable',
        artifactFolder: 'artifacts/base-stable',
      });
    });

    it('package:cef produces dist/variant.json with the cef variant', () => {
      runPackageScript('package:cef');
      expect(readDistVariantJson()).toEqual({
        variant: 'cef',
        releaseTrack: 'stable',
        electrobunBuildEnv: 'stable',
        bundleCEF: true,
        defaultRenderer: 'cef',
        buildFolder: 'build/cef-stable',
        artifactFolder: 'artifacts/cef-stable',
      });
    });
  },
);
