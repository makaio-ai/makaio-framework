/**
 * Build all framework extensions discovered via `descriptor.json` glob.
 *
 * Finds every workspace package under `framework/` that has a
 * `descriptor.json`, a `build` script in its `package.json`, and a sibling
 * `tsdown.config.ts`. Loads each config and builds via tsdown's programmatic
 * API.
 *
 * Packages with a `descriptor.json` but no `tsdown.config.ts` are logged as
 * skipped — they need migrating to a tsdown config before this script can
 * build them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import { build, type UserConfig } from 'tsdown';

const FRAMEWORK_ROOT = import.meta.dirname ? join(import.meta.dirname, '..') : process.cwd();

const descriptors = globSync('**/descriptor.json', {
  cwd: FRAMEWORK_ROOT,
  ignore: ['**/node_modules/**', '**/dist/**', '**/__tests__/**', '**/fixtures/**'],
  absolute: true,
});

interface BuildTarget {
  readonly name: string;
  readonly dir: string;
}

const targets: BuildTarget[] = [];
const skipped: BuildTarget[] = [];

for (const descriptorPath of descriptors) {
  const pkgDir = dirname(descriptorPath);
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };

  if (!pkg.name || !pkg.scripts?.['build']) continue;

  const configPath = join(pkgDir, 'tsdown.config.ts');
  if (existsSync(configPath)) {
    targets.push({ name: pkg.name, dir: pkgDir });
  } else {
    skipped.push({ name: pkg.name, dir: pkgDir });
  }
}

if (targets.length === 0 && skipped.length === 0) {
  console.info('[build:extensions] No buildable extensions found.');
  process.exit(0);
}

if (skipped.length > 0) {
  console.info(`[build:extensions] Skipped ${skipped.length} package(s) without tsdown.config.ts:`);
  for (const s of skipped) {
    console.info(`  ${s.name}`);
  }
}

if (targets.length > 0) {
  console.info(`[build:extensions] Building ${targets.length} extension(s):`);
  for (const t of targets) {
    console.info(`  ${t.name}`);
  }
}

const start = performance.now();

/**
 * Load a package's tsdown config and build it.
 *
 * Changes `process.cwd()` to the package directory so that relative entry
 * paths in the config resolve correctly, then restores the previous CWD.
 * @param target - Package to build.
 */
async function buildExtension(target: BuildTarget): Promise<void> {
  const configPath = join(target.dir, 'tsdown.config.ts');
  const previousCwd = process.cwd();
  process.chdir(target.dir);
  try {
    const configModule = (await import(pathToFileURL(configPath).href)) as {
      default: UserConfig | UserConfig[];
    };
    const configs = Array.isArray(configModule.default) ? configModule.default : [configModule.default];

    for (const config of configs) {
      await build(config);
    }
  } finally {
    process.chdir(previousCwd);
  }
}

let failures = 0;

for (const target of targets) {
  const extStart = performance.now();
  try {
    await buildExtension(target);
    const elapsed = ((performance.now() - extStart) / 1000).toFixed(1);
    console.info(`[build:extensions] ${target.name} done in ${elapsed}s`);
  } catch (error) {
    failures++;
    console.error(`[build:extensions] ${target.name} FAILED:`, error instanceof Error ? error.message : error);
  }
}

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.info(`\n[build:extensions] ${targets.length - failures}/${targets.length} built in ${elapsed}s`);

if (failures > 0) {
  process.exit(1);
}
