import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import frameworkPackageJson from '../package.json' with { type: 'json' };
import { FRAMEWORK_DIST_SUBPATHS } from '../build-tooling/framework-public-surface.js';

const FRAMEWORK_ROOT = dirname(import.meta.dirname);
const DIST = join(FRAMEWORK_ROOT, 'dist');

type ExportRecord = Record<string, string | { types?: string; default?: string }>;

/**
 * Collect all file targets for an export entry.
 *
 * Both `types` and `default` are validated independently so a missing
 * `.d.ts` is caught even when the runtime `.js` exists.
 * @param value - Export entry value from package.json.
 * @returns All declared file paths for this export entry.
 */
function getExportTargets(value: string | { types?: string; default?: string }): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  return [value.default, value.types].filter((target): target is string => target !== undefined);
}

/**
 * Validate that the umbrella export map and assembled dist stay aligned.
 */
function validatePublicSurface(): void {
  const exportMap = ((frameworkPackageJson as { publishConfig?: { exports?: ExportRecord } }).publishConfig?.exports ??
    {}) as ExportRecord;
  const exportKeys = new Set(Object.keys(exportMap));

  const missingExportKeys = FRAMEWORK_DIST_SUBPATHS.map((entry) => `./${entry.subpath}`).filter(
    (exportKey) => !exportKeys.has(exportKey),
  );

  const missingExportTargets = Object.entries(exportMap)
    .filter(([exportKey]) => exportKey !== './package.json')
    .flatMap(([exportKey, value]) => getExportTargets(value).map((target) => ({ exportKey, target })))
    .filter((entry) => entry.target.startsWith('./dist/'))
    .filter((entry) => !existsSync(join(FRAMEWORK_ROOT, entry.target)));

  if (missingExportKeys.length === 0 && missingExportTargets.length === 0) {
    return;
  }

  const problems: string[] = [];

  if (missingExportKeys.length > 0) {
    problems.push('Missing publishConfig.exports entries:');
    problems.push(...missingExportKeys.map((key) => `- ${key}`));
  }

  if (missingExportTargets.length > 0) {
    problems.push('Missing assembled files for publishConfig.exports targets:');
    problems.push(...missingExportTargets.map((entry) => `- ${entry.exportKey} -> ${entry.target}`));
  }

  throw new Error(`Public surface parity validation failed:\n${problems.join('\n')}`);
}

// Clean existing dist
if (existsSync(DIST)) rmSync(DIST, { recursive: true });

// Copy each package's dist into the framework dist layout
let assembled = 0;
const missing: string[] = [];
for (const { subpath, sourceDist } of FRAMEWORK_DIST_SUBPATHS) {
  const src = join(FRAMEWORK_ROOT, sourceDist);
  const dest = join(DIST, subpath);

  if (!existsSync(src)) {
    missing.push(`${subpath} -> ${sourceDist}`);
    continue;
  }

  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.info(`  ${subpath}/ <- ${sourceDist}`);
  assembled++;
}

if (missing.length > 0) {
  throw new Error(
    `Missing build outputs for ${missing.length} subpath(s):\n${missing.map((m) => `- ${m}`).join('\n')}`,
  );
}

validatePublicSurface();

console.info(`\nAssembled ${assembled} subpath entries into ${DIST}`);
