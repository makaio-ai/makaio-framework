import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  FRAMEWORK_BUILD_PACKAGE_NAMES,
  FRAMEWORK_DIST_SUBPATHS,
} from '../../build-tooling/framework-public-surface.js';
import { checkBuildSurface } from './build-surface-invariants.js';

/**
 * Writes a `package.json` fixture at the given path.
 * @param dir - Absolute directory to write into.
 * @param manifest - Package manifest content.
 */
function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Writes the umbrella `packages/framework/package.json` with the given exports.
 * @param root - Absolute framework workspace root directory.
 * @param exports - Map of export keys to values.
 */
function writeUmbrellaManifest(root: string, exports: Record<string, unknown>): void {
  const dir = join(root, 'packages', 'framework');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@makaio/framework', exports }, null, 2));
}

/**
 * Builds the umbrella exports map containing every FRAMEWORK_DIST_SUBPATHS entry.
 * @returns Full umbrella exports record.
 */
function buildFullUmbrellaExports(): Record<string, unknown> {
  const exports: Record<string, unknown> = { './package.json': './package.json' };
  for (const entry of FRAMEWORK_DIST_SUBPATHS) {
    exports[`./${entry.subpath}`] = {
      types: `./dist/${entry.subpath}/index.d.mts`,
      default: `./dist/${entry.subpath}/index.mjs`,
    };
  }
  return exports;
}

/**
 * Creates a minimal framework workspace that satisfies all invariants.
 *
 * All packages from FRAMEWORK_BUILD_PACKAGE_NAMES are written as simple
 * (non-tsdown) workspaces, so source/publishConfig parity is not checked.
 * The umbrella exports include every FRAMEWORK_DIST_SUBPATHS entry.
 * @param root - Absolute temp dir to write into.
 */
function writeMinimalValidFixture(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@makaio/framework-workspace', private: true }));
  for (const pkgName of FRAMEWORK_BUILD_PACKAGE_NAMES) {
    const safeDir = pkgName.replace('@makaio/', '').replace(/\//g, '-');
    writePackage(join(root, 'packages', safeDir), { name: pkgName });
  }
  writeUmbrellaManifest(root, buildFullUmbrellaExports());
}

describe('checkBuildSurface', () => {
  const tempDirs: string[] = [];

  /**
   * Creates a tracked temp directory.
   * @returns Absolute path to the new temp directory.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'build-surface-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok:true for a minimal valid fixture', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);
    const result = checkBuildSurface(root);
    expect(result.ok, result.issues.map((i) => i.message).join('\n')).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('reports missing-workspace when a FRAMEWORK_BUILD_PACKAGE_NAMES entry has no package.json', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);
    rmSync(join(root, 'packages', 'bus-core'), { recursive: true, force: true });

    const result = checkBuildSurface(root);
    const missing = result.issues.filter((i) => i.kind === 'missing-workspace');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]?.message).toContain('@makaio/bus-core');
  });

  it('reports dist-subpath-not-in-umbrella when a FRAMEWORK_DIST_SUBPATHS entry is absent from umbrella exports', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const exportsWithoutClients = buildFullUmbrellaExports();
    delete exportsWithoutClients['./clients'];
    writeUmbrellaManifest(root, exportsWithoutClients);

    const result = checkBuildSurface(root);
    const issues = result.issues.filter((i) => i.kind === 'dist-subpath-not-in-umbrella');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain('./clients');
  });

  it('reports umbrella-export-not-rooted-in-subpath for orphaned dist exports', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const exportsWithOrphan = buildFullUmbrellaExports();
    exportsWithOrphan['./phantom'] = {
      types: './dist/phantom/index.d.mts',
      default: './dist/phantom/index.mjs',
    };
    writeUmbrellaManifest(root, exportsWithOrphan);

    const result = checkBuildSurface(root);
    const issues = result.issues.filter((i) => i.kind === 'umbrella-export-not-rooted-in-subpath');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('./phantom'))).toBe(true);
  });

  it('reports source-export-missing-from-publishconfig for tsdown packages with unpublished exports', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const pkgDir = join(root, 'packages', 'bus-core');
    writePackage(pkgDir, {
      name: '@makaio/bus-core',
      scripts: { build: 'tsdown' },
      exports: {
        '.': './src/index.ts',
        './extra': './src/extra.ts',
        './package.json': './package.json',
      },
      publishConfig: {
        exports: {
          '.': './dist/index.mjs',
          './package.json': './package.json',
        },
      },
    });

    const result = checkBuildSurface(root);
    const issues = result.issues.filter((i) => i.kind === 'source-export-missing-from-publishconfig');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain('./extra');
  });

  it('does not flag ./package.json or CSS exports in tsdown packages', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const pkgDir = join(root, 'packages', 'bus-core');
    writePackage(pkgDir, {
      name: '@makaio/bus-core',
      scripts: { build: 'tsdown' },
      exports: {
        '.': './src/index.ts',
        './style': './src/style.css',
        './package.json': './package.json',
      },
      publishConfig: {
        exports: {
          '.': './dist/index.mjs',
          './package.json': './package.json',
        },
      },
    });

    const result = checkBuildSurface(root);
    const issues = result.issues.filter((i) => i.kind === 'source-export-missing-from-publishconfig');
    expect(issues).toHaveLength(0);
  });

  it('treats conditional import-only TypeScript exports as buildable', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const pkgDir = join(root, 'packages', 'bus-core');
    writePackage(pkgDir, {
      name: '@makaio/bus-core',
      scripts: { build: 'tsdown' },
      exports: {
        '.': {
          import: './src/index.ts',
          types: './src/index.ts',
        },
        './package.json': './package.json',
      },
      publishConfig: {
        exports: {
          './package.json': './package.json',
        },
      },
    });

    const result = checkBuildSurface(root);
    const issues = result.issues.filter((i) => i.kind === 'source-export-missing-from-publishconfig');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('source export "."');
  });

  it('does not flag non-dist umbrella exports like ./package.json', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const result = checkBuildSurface(root);
    const orphaned = result.issues.filter((i) => i.kind === 'umbrella-export-not-rooted-in-subpath');
    expect(orphaned).toHaveLength(0);
  });

  it('returns ok:false and has issues when packages are missing', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@makaio/framework-workspace', private: true }));
    writeUmbrellaManifest(root, { './package.json': './package.json' });

    const result = checkBuildSurface(root);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('umbrella exports with sub-subpath entries like ./services/capability are accepted when rooted under ./services', () => {
    const root = makeTempDir();
    writeMinimalValidFixture(root);

    const exportsWithSubSubpath = buildFullUmbrellaExports();
    exportsWithSubSubpath['./services/capability'] = {
      types: './dist/services/capability/index.d.mts',
      default: './dist/services/capability/index.mjs',
    };
    writeUmbrellaManifest(root, exportsWithSubSubpath);

    const result = checkBuildSurface(root);
    const orphaned = result.issues.filter((i) => i.kind === 'umbrella-export-not-rooted-in-subpath');
    expect(orphaned).toHaveLength(0);
  });
});
