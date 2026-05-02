import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTABLE_SOURCE_DIRECTORY,
  createPortablePackageJson,
  readFrameworkPackageVersions,
  resolveRepoRoot,
  type ExtensionPackageJson,
} from './package-mode.js';

const EXCLUDED_TOP_LEVEL_NAMES = new Set([
  'build',
  'dist',
  'node_modules',
  '.yarn',
  'yarn.lock',
  'tsconfig.repo-dev.json',
]);

/**
 * Stage a portable account-manager source package beneath `build/portable-source`.
 */
async function main(): Promise<void> {
  const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolveRepoRoot(extensionRoot);
  const outputRoot = path.join(extensionRoot, PORTABLE_SOURCE_DIRECTORY);
  const portablePackageJsonPath = path.join(outputRoot, 'package.json');

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const topLevelEntries = await readdir(extensionRoot);
  await Promise.all(
    topLevelEntries
      .filter((entryName) => !EXCLUDED_TOP_LEVEL_NAMES.has(entryName))
      .map(async (entryName) => {
        const sourcePath = path.join(extensionRoot, entryName);
        const destinationPath = path.join(outputRoot, entryName);
        await cp(sourcePath, destinationPath, { recursive: true });
      }),
  );

  const versions = await readFrameworkPackageVersions(repoRoot);
  const sourcePackageJson = JSON.parse(
    await readFile(path.join(extensionRoot, 'package.json'), 'utf8'),
  ) as ExtensionPackageJson;

  await writeFile(
    portablePackageJsonPath,
    `${JSON.stringify(createPortablePackageJson(sourcePackageJson, versions), null, 2)}\n`,
    'utf8',
  );

  // descriptor.json entrypoints use the convention-based format (true | stem)
  // and resolve automatically at runtime — no rewriting needed for portable packages.

  console.info(`Prepared portable source package at ${outputRoot}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[account-manager] Failed to prepare portable package: ${message}`);
  process.exitCode = 1;
});
