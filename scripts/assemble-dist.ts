import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import frameworkPackageJson from '../package.json' with { type: 'json' };

const FRAMEWORK_ROOT = dirname(import.meta.dirname);
const DIST = join(FRAMEWORK_ROOT, 'dist');

/**
 * Maps each subpath export name to the source package's dist directory.
 *
 * The key is the subpath (e.g., 'bus'), and the output goes to `dist/<key>/`.
 * Each package's `dist/` is copied as-is into its subpath directory.
 *
 * This map is intentionally hardcoded rather than derived from package.json exports,
 * because the mapping between workspace packages and framework subpaths is a deliberate
 * architectural decision — not all workspace packages become framework subpaths.
 */
const SUBPATH_MAP: Record<string, string> = {
  // Core
  bus: 'packages/bus-core/dist',
  core: 'packages/makaio-core/dist',
  utils: 'packages/utils/dist',
  'service-base': 'packages/services/base/dist',
  contracts: 'packages/contracts/dist',
  hooks: 'packages/hooks/dist',
  kernel: 'packages/kernel/dist',
  services: 'packages/services/core/dist',
  'services/log-import': 'packages/services/log-import/dist',
  providers: 'packages/providers/dist',

  // Storage
  storage: 'packages/storage/core/dist',
  'storage/drizzle': 'packages/storage/drizzle/dist',
  'storage/handlers': 'packages/storage/handlers/dist',

  // Adapters
  adapters: 'adapters/core/dist',
  'adapters/stream-session': 'adapters/shared/stream-session/dist',
  'adapters/stream-session/testing': 'adapters/shared/stream-session/dist/testing',
  'adapters/acp-client': 'adapters/shared/acp-client/dist',

  // Tools
  tools: 'tools/core/dist',
  'tools/testing': 'tools/core/dist/testing',
  'tools/filesystem': 'tools/filesystem/dist',
  'tools/shell': 'tools/shell/dist',
  'tools/subagent': 'tools/subagent/dist',

  // Node infrastructure
  'node/bus-server': 'packages/bus-server/dist',
  'node/transports': 'transports/ws/dist',
  'node/machine-identity': 'packages/machine-identity/dist',

  // Testing
  testing: 'packages/test-utils/dist',

  // UI packages
  'ui-kernel': 'ui/kernel/dist',
  'ui-components': 'ui/components/dist',
  'ui-hooks': 'ui/hooks/dist',
  'ui-views': 'ui/views/dist',
};

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

  const missingExportKeys = Object.keys(SUBPATH_MAP)
    .map((subpath) => `./${subpath}`)
    .filter((exportKey) => !exportKeys.has(exportKey));

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
for (const [subpath, sourceDist] of Object.entries(SUBPATH_MAP)) {
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
