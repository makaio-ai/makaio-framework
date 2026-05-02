import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { ExtensionScaffoldBuildOptions, ScaffoldFile } from './extension-scaffold-files.js';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../../');
const CLI_RUNTIME_PACKAGE = {
  name: '@makaio/kernel',
  repoDevPaths: {
    '@makaio/kernel': ['./node_modules/@makaio/kernel/src/index.ts'],
    '@makaio/kernel/cli': ['./node_modules/@makaio/kernel/src/cli/index.ts'],
    '@makaio/kernel/cli/schemas': ['./node_modules/@makaio/kernel/src/cli/schemas.ts'],
    '@makaio/kernel/cli/register': ['./node_modules/@makaio/kernel/src/cli/register.ts'],
  },
  repoDevAlias: "'@makaio/kernel': 'src'",
  versionPackageJsonPath: 'packages/kernel/package.json',
} as const;

/**
 * Build repo-dev and portable-package scaffold files.
 * @param options - Normalized scaffold options.
 * @returns Additional scaffold files for explicit package modes.
 */
export function buildPortableScaffoldFiles(options: ExtensionScaffoldBuildOptions): readonly ScaffoldFile[] {
  return [
    { relativePath: '.gitignore', contents: buildGitignore() },
    { relativePath: 'tsconfig.json', contents: buildTsconfig() },
    { relativePath: 'tsconfig.repo-dev.json', contents: buildRepoDevTsconfig(options) },
    { relativePath: 'vitest.config.ts', contents: buildVitestConfig(options) },
    { relativePath: 'scripts/package-mode.ts', contents: buildPackageModeScript() },
    { relativePath: 'scripts/run-with-mode.ts', contents: buildRunWithModeScript() },
    { relativePath: 'scripts/prepare-portable-package.mjs', contents: buildPreparePortablePackageScript(options) },
  ];
}

/**
 * Build the generated `.gitignore`.
 * @returns Gitignore contents.
 */
function buildGitignore(): string {
  return ['node_modules/', 'dist/', 'build/', '.yarn/*', '!.yarn/releases', ''].join('\n');
}

/**
 * Build the generated tsconfig.
 * @returns tsconfig contents.
 */
function buildTsconfig(): string {
  // The generated project typechecks scripts and tests alongside src, so the
  // scaffold cannot pin rootDir to src without excluding its own tooling files.
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: '.',
      declaration: false,
      sourceMap: true,
      types: ['node'],
    },
    include: ['src', 'scripts', 'test'],
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

/**
 * Build the repo-dev tsconfig override.
 * @param options - Normalized scaffold options.
 * @returns tsconfig source.
 */
function buildRepoDevTsconfig(options: ExtensionScaffoldBuildOptions): string {
  const paths: Record<string, string[]> = {
    '@makaio/cli': ['./node_modules/@makaio/cli/src'],
    '@makaio/contracts': ['./node_modules/@makaio/contracts/src'],
    '@makaio/contracts/*': ['./node_modules/@makaio/contracts/src/*'],
  };

  if (options.surfaces.includes('browser')) {
    paths['@makaio/ui-kernel'] = ['./node_modules/@makaio/ui-kernel/src'];
  }
  if (options.surfaces.includes('cli')) {
    Object.assign(paths, CLI_RUNTIME_PACKAGE.repoDevPaths);
  }

  return `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        baseUrl: '.',
        paths,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Build the generated Vitest config.
 * @param options - Normalized scaffold options.
 * @returns Vitest config source.
 */
function buildVitestConfig(options: ExtensionScaffoldBuildOptions): string {
  const repoDevAliases = ["'@makaio/cli': 'src'", "'@makaio/contracts': 'src'"];
  if (options.surfaces.includes('cli')) {
    repoDevAliases.push(CLI_RUNTIME_PACKAGE.repoDevAlias);
  }

  return [
    "import { defineConfig } from 'vitest/config';",
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';",
    '',
    'const extensionRoot = path.dirname(fileURLToPath(import.meta.url));',
    '',
    'export default defineConfig({',
    "  root: '.',",
    '  test: {',
    '    globals: true,',
    "    environment: 'node',",
    "    include: ['test/**/*.test.ts'],",
    '    exclude: [',
    "      '**/node_modules/**',",
    "      '**/dist/**',",
    "      '**/build/**',",
    '    ],',
    '  },',
    '  resolve: {',
    '    tsconfigPaths: true,',
    '    ...(isRepoDevMode()',
    '      ? {',
    `          alias: createRepoDevAliases(extensionRoot, { ${repoDevAliases.join(', ')} }),`,
    '        }',
    '      : {}),',
    '  },',
    '});',
    '',
  ].join('\n');
}

/**
 * Build the generated package-mode helper script.
 * @returns Script source.
 */
function buildPackageModeScript(): string {
  return [
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "export const REPO_DEV_MODE = 'repo-dev';",
    '',
    'export function isRepoDevMode(env: NodeJS.ProcessEnv = process.env): boolean {',
    "  return env['MAKAIO_EXTENSION_MODE'] === REPO_DEV_MODE;",
    '}',
    '',
    'export function resolveExtensionRoot(fromFileUrl: string = import.meta.url): string {',
    "  return path.resolve(path.dirname(fileURLToPath(fromFileUrl)), '..');",
    '}',
    '',
    'function resolveInstalledPackagePath(extensionRoot: string, packageName: string): string {',
    "  return path.join(extensionRoot, 'node_modules', ...packageName.split('/'));",
    '}',
    '',
    'export function createRepoDevAliases(',
    '  extensionRoot: string,',
    '  aliases: Record<string, string>,',
    '): Record<string, string> {',
    '  return Object.fromEntries(',
    '    Object.entries(aliases).map(([specifier, packageSubpath]) => {',
    '      return [specifier, path.join(resolveInstalledPackagePath(extensionRoot, specifier), packageSubpath)];',
    '    }),',
    '  );',
    '}',
    '',
  ].join('\n');
}

/**
 * Build the framework package version map used by portable staging scripts.
 * @param options - Normalized scaffold options.
 * @returns Package versions keyed by package name.
 */
function buildFrameworkPackageVersions(options: ExtensionScaffoldBuildOptions): Record<string, string> {
  const frameworkPackageVersions: Record<string, string> = {
    '@makaio/build-tooling': readFrameworkPackageVersion('build-tooling/package.json'),
    '@makaio/cli': readFrameworkPackageVersion('apps/cli/package.json'),
    '@makaio/contracts': readFrameworkPackageVersion('packages/contracts/package.json'),
  };

  if (options.surfaces.includes('browser')) {
    frameworkPackageVersions['@makaio/ui-kernel'] = readFrameworkPackageVersion('ui/kernel/package.json');
  }
  if (options.surfaces.includes('cli')) {
    frameworkPackageVersions[CLI_RUNTIME_PACKAGE.name] = readFrameworkPackageVersion(
      CLI_RUNTIME_PACKAGE.versionPackageJsonPath,
    );
  }

  return frameworkPackageVersions;
}

/**
 * Read a framework package version from the repo.
 * @param repoRelativePath - Package.json path relative to the repo root.
 * @returns Package version string.
 */
function readFrameworkPackageVersion(repoRelativePath: string): string {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8')) as {
    readonly version?: unknown;
  };

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`Missing package version in ${repoRelativePath}`);
  }

  return packageJson.version;
}

/**
 * Build the repo-dev runner script.
 * @returns Script source.
 */
function buildRunWithModeScript(): string {
  return [
    "import { spawn } from 'node:child_process';",
    '',
    'async function main(): Promise<void> {',
    '  const [mode, command, ...args] = process.argv.slice(2);',
    '',
    '  if (!mode || !command) {',
    "    throw new Error('Usage: tsx ./scripts/run-with-mode.ts <mode> <command> [...args]');",
    '  }',
    '',
    '  const child = spawn(command, args, {',
    "    stdio: 'inherit',",
    "    shell: process.platform === 'win32',",
    '    env: {',
    '      ...process.env,',
    '      MAKAIO_EXTENSION_MODE: mode,',
    '    },',
    '  });',
    '',
    '  const exitCode = await new Promise<number>((resolve, reject) => {',
    "    child.once('error', reject);",
    "    child.once('exit', (code, signal) => {",
    '      if (signal) {',
    '        reject(new Error(`${command} exited via signal ${signal}`));',
    '        return;',
    '      }',
    '',
    '      resolve(code ?? 0);',
    '    });',
    '  });',
    '',
    '  process.exitCode = exitCode;',
    '}',
    '',
    'void main().catch((error) => {',
    '  const attemptedMode = process.argv[2];',
    '  const message = error instanceof Error ? error.message : String(error);',
    "  console.error(`[extension] Failed to start ${attemptedMode ?? 'unknown'} command: ${message}`);",
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}

/**
 * Build the portable package staging script.
 * @param options - Normalized scaffold options.
 * @returns Script source.
 */
function buildPreparePortablePackageScript(options: ExtensionScaffoldBuildOptions): string {
  const frameworkPackageVersions = buildFrameworkPackageVersions(options);

  return [
    "import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';",
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const PORTABLE_SOURCE_DIRECTORY = 'build/portable-source';",
    "const EXCLUDED_TOP_LEVEL_NAMES = new Set(['build', 'dist', 'node_modules', '.yarn', 'yarn.lock', 'tsconfig.repo-dev.json']);",
    `const FRAMEWORK_PACKAGE_VERSIONS = ${JSON.stringify(frameworkPackageVersions, null, 2)};`,
    '',
    'function resolveExtensionRoot(fromFileUrl = import.meta.url) {',
    "  return path.resolve(path.dirname(fileURLToPath(fromFileUrl)), '..');",
    '}',
    '',
    'function createPortablePackageJson(packageJson) {',
    '  const devDependencies = { ...(packageJson.devDependencies ?? {}) };',
    '  for (const [packageName, version] of Object.entries(FRAMEWORK_PACKAGE_VERSIONS)) {',
    '    if (devDependencies[packageName]) {',
    '      devDependencies[packageName] = `^${version}`;',
    '    }',
    '  }',
    '',
    '  return {',
    '    ...packageJson,',
    '    scripts: {',
    "      build: 'tsdown',",
    "      test: 'vitest run --config vitest.config.ts',",
    "      verify: 'vitest run test/verify.test.ts --config vitest.config.ts',",
    '    },',
    '    devDependencies,',
    '  };',
    '}',
    '',
    'async function main() {',
    '  const extensionRoot = resolveExtensionRoot(import.meta.url);',
    '  const outputRoot = path.join(extensionRoot, PORTABLE_SOURCE_DIRECTORY);',
    '',
    '  await rm(outputRoot, { recursive: true, force: true });',
    '  await mkdir(outputRoot, { recursive: true });',
    '',
    '  const topLevelEntries = await readdir(extensionRoot);',
    '  await Promise.all(',
    '    topLevelEntries',
    '      .filter((entryName) => !EXCLUDED_TOP_LEVEL_NAMES.has(entryName))',
    '      .map(async (entryName) => {',
    '        await cp(path.join(extensionRoot, entryName), path.join(outputRoot, entryName), { recursive: true });',
    '      }),',
    '  );',
    '',
    "  const sourcePackageJson = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));",
    '',
    '  await writeFile(',
    "    path.join(outputRoot, 'package.json'),",
    '    `${JSON.stringify(createPortablePackageJson(sourcePackageJson), null, 2)}\\n`,',
    "    'utf8',",
    '  );',
    '',
    '  console.info(`Prepared portable source package at ${outputRoot}`);',
    '}',
    '',
    'void main().catch((error) => {',
    '  const message = error instanceof Error ? error.message : String(error);',
    '  console.error(`[extension] Failed to prepare portable package: ${message}`);',
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}
