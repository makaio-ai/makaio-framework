/**
 * Build all framework descriptor packages discovered via `descriptor.json`.
 *
 * Finds every workspace package under `framework/` that has a
 * `descriptor.json` and a `build` script in its `package.json`, then delegates
 * to that package's build script.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globSync } from 'glob';

const FRAMEWORK_ROOT = import.meta.dirname ? join(import.meta.dirname, '..') : process.cwd();

const descriptors = globSync('**/descriptor.json', {
  cwd: FRAMEWORK_ROOT,
  ignore: ['**/node_modules/**', '**/dist/**', '**/__tests__/**', '**/fixtures/**'],
  absolute: true,
});

interface BuildTarget {
  readonly name: string;
}

const targets: BuildTarget[] = [];

for (const descriptorPath of descriptors) {
  const pkgDir = dirname(descriptorPath);
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };

  if (!pkg.name || !pkg.scripts?.['build']) continue;

  targets.push({ name: pkg.name });
}

targets.sort((a, b) => a.name.localeCompare(b.name));

if (targets.length === 0) {
  console.info('[build:extensions] No buildable descriptor packages found.');
  process.exit(0);
}

console.info(`[build:extensions] Building ${targets.length} descriptor package(s):`);
for (const t of targets) {
  console.info(`  ${t.name}`);
}

const start = performance.now();

/**
 * Run a descriptor package's build script.
 * @param target - Package to build.
 */
function buildDescriptorPackage(target: BuildTarget): void {
  execFileSync('yarn', ['workspace', target.name, 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

let failures = 0;

for (const target of targets) {
  const extStart = performance.now();
  try {
    buildDescriptorPackage(target);
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
