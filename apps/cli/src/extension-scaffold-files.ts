import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { EmbeddedDescriptor, ExtensionEntrypoints } from '@makaio/contracts';
import type { ExtensionSurface } from './extension-init.js';
import { buildPortableScaffoldFiles } from './extension-scaffold-portable.js';
import { buildVerifyTest } from './extension-verify-test.js';
import { toRelativeImportPath } from './extension-path.js';

const DEFAULT_EXTENSION_VERSION = '0.1.0';
const DEFAULT_MAKAIO_MIN_VERSION = '0.1.0';
const DEFAULT_DEV_DEPENDENCY_VERSIONS = {
  tsdown: '^0.21.7',
  tsx: '^4.20.4',
  typescript: '^6.0.2',
  vitest: '^4.1.0',
} as const;
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../../');

/**
 * Options required to build scaffold files.
 */
export interface ExtensionScaffoldBuildOptions {
  /** Canonical extension name. */
  readonly name: string;
  /** Normalized display name. */
  readonly displayName: string;
  /** Generated package name. */
  readonly packageName: string;
  /** Selected surfaces in canonical order. */
  readonly surfaces: readonly ExtensionSurface[];
  /** Absolute scaffold root. */
  readonly rootDir: string;
}

/**
 * Result for a generated scaffold file.
 */
export interface ScaffoldFile {
  /** Relative path within the scaffold root. */
  readonly relativePath: string;
  /** File contents. */
  readonly contents: string;
}

/**
 * Build the full set of scaffold files.
 * @param options - Normalized scaffold options.
 * @returns Relative file paths and contents.
 */
export function buildScaffoldFiles(options: ExtensionScaffoldBuildOptions): readonly ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { relativePath: 'package.json', contents: buildPackageJson(options) },
    { relativePath: 'descriptor.json', contents: buildDescriptorJson(options) },
    { relativePath: 'tsdown.config.ts', contents: buildTsdownConfig(options) },
    { relativePath: 'README.md', contents: buildReadme(options) },
    { relativePath: 'test/verify.test.ts', contents: buildVerifyTest(options) },
    ...buildPortableScaffoldFiles(options),
  ];

  if (options.surfaces.includes('server')) {
    files.push({ relativePath: 'src/server.ts', contents: buildServerEntrypoint(options) });
  }
  if (options.surfaces.includes('browser')) {
    files.push({ relativePath: 'src/browser.ts', contents: buildBrowserEntrypoint() });
  }
  if (options.surfaces.includes('cli')) {
    files.push({ relativePath: 'src/cli.ts', contents: buildCliEntrypoint(options) });
  }

  return files;
}

/**
 * Build the generated `package.json`.
 * @param options - Normalized scaffold options.
 * @returns JSON string with trailing newline.
 */
function buildPackageJson(options: ExtensionScaffoldBuildOptions): string {
  const devDependencies: Record<string, string> = {
    '@makaio/build-tooling': toWorkspaceLink(options.rootDir, 'build-tooling'),
    '@makaio/cli': toWorkspaceLink(options.rootDir, 'apps/cli'),
    '@makaio/contracts': toWorkspaceLink(options.rootDir, 'packages/contracts'),
    ...DEFAULT_DEV_DEPENDENCY_VERSIONS,
  };

  if (options.surfaces.includes('browser')) {
    devDependencies['@makaio/ui-kernel'] = toWorkspaceLink(options.rootDir, 'ui/kernel');
  }
  if (options.surfaces.includes('cli')) {
    devDependencies['@makaio/kernel'] = toWorkspaceLink(options.rootDir, 'packages/kernel');
  }

  const runtimeDependencies: Record<string, string> = {};
  if (options.surfaces.includes('cli')) {
    runtimeDependencies.zod = '^4.1.13';
  }

  const sourceExports = buildSurfaceExports(options.surfaces, 'src', {
    server: 'server.ts',
    browser: 'browser.ts',
    cli: 'cli.ts',
  });
  sourceExports['./package.json'] = './package.json';

  const publishExports = buildSurfaceExports(options.surfaces, 'dist', {
    server: 'server.mjs',
    browser: 'browser.mjs',
    cli: 'cli.mjs',
  });
  publishExports['./package.json'] = './package.json';

  return `${JSON.stringify(
    {
      name: options.packageName,
      version: DEFAULT_EXTENSION_VERSION,
      private: true,
      type: 'module',
      exports: sourceExports,
      scripts: {
        build: 'tsx ./scripts/run-with-mode.ts repo-dev tsdown',
        test: 'tsx ./scripts/run-with-mode.ts repo-dev vitest run --config vitest.config.ts',
        verify: 'tsx ./scripts/run-with-mode.ts repo-dev vitest run test/verify.test.ts --config vitest.config.ts',
        'prepare:portable-package': 'node ./scripts/prepare-portable-package.mjs',
      },
      ...(Object.keys(runtimeDependencies).length > 0 ? { dependencies: runtimeDependencies } : {}),
      devDependencies,
      publishConfig: {
        exports: publishExports,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Build the generated descriptor.
 * @param options - Normalized scaffold options.
 * @returns JSON string with trailing newline.
 */
function buildDescriptorJson(options: ExtensionScaffoldBuildOptions): string {
  const descriptor: EmbeddedDescriptor = {
    name: options.name,
    displayName: options.displayName,
    version: DEFAULT_EXTENSION_VERSION,
    makaio: {
      minVersion: DEFAULT_MAKAIO_MIN_VERSION,
    },
    entrypoints: buildDescriptorEntrypoints(options.surfaces),
    ...(options.surfaces.includes('cli') ? { cli: buildCliManifest(options) } : {}),
    execution: 'embedded',
  };

  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

/**
 * Build the descriptor entrypoints object.
 * @param surfaces - Selected surfaces.
 * @returns Convention-based entrypoints for the descriptor.
 */
function buildDescriptorEntrypoints(surfaces: readonly ExtensionSurface[]): ExtensionEntrypoints {
  return {
    ...(surfaces.includes('server') ? { server: true as const } : {}),
    ...(surfaces.includes('browser') ? { browser: true as const } : {}),
    ...(surfaces.includes('cli') ? { cli: true as const } : {}),
  };
}

/**
 * Build the serializable CLI manifest used in `descriptor.json`.
 *
 * The doctor subcommand name and description are intentionally duplicated in
 * {@link buildCliEntrypoint}; one generates JSON metadata while the other
 * generates executable TypeScript source.
 * @param options - Normalized scaffold options.
 * @returns Minimal CLI manifest metadata.
 */
function buildCliManifest(options: ExtensionScaffoldBuildOptions): NonNullable<EmbeddedDescriptor['cli']> {
  return {
    name: options.name,
    description: `CLI commands for ${options.displayName}`,
    subcommands: [
      {
        name: 'doctor',
        description: 'Check that the scaffolded CLI surface is wired correctly',
      },
    ],
  };
}

/**
 * Build the generated tsdown config.
 * @param options - Normalized scaffold options.
 * @returns tsdown config source.
 */
function buildTsdownConfig(options: ExtensionScaffoldBuildOptions): string {
  const entries = options.surfaces.map((surface) => `    ${surface}: './src/${surface}.ts',`).join('\n');
  const aliasEntries = buildRepoDevAliasEntries(options);

  return [
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "import { mergeConfig } from 'tsdown';",
    "import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';",
    "import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';",
    '',
    'const baseConfig = defineExtensionConfig({',
    '  entry: {',
    entries,
    '  },',
    '});',
    '',
    'const extensionRoot = path.dirname(fileURLToPath(import.meta.url));',
    '',
    'export default isRepoDevMode()',
    '  ? mergeConfig(baseConfig, {',
    '      alias: createRepoDevAliases(extensionRoot, {',
    aliasEntries,
    '      }),',
    '    })',
    '  : baseConfig;',
    '',
  ].join('\n');
}

/**
 * Build the generated README.
 * @param options - Normalized scaffold options.
 * @returns Markdown string.
 */
function buildReadme(options: ExtensionScaffoldBuildOptions): string {
  const surfaceList = options.surfaces.map((surface) => `- \`${surface}\``).join('\n');

  return [
    `# ${options.displayName}`,
    '',
    'Scaffold generated by `makaio extension init`.',
    '',
    '## Selected Surfaces',
    surfaceList,
    '',
    '## Workflow',
    '- `descriptor.json` stays canonical for install and discovery metadata.',
    '- Run `yarn install` before invoking `yarn build`, `yarn test`, or `yarn verify`.',
    '- `tsdown.config.ts` builds only the selected entrypoints through the Makaio preset.',
    '- `test/verify.test.ts` is the starting point for contract-oriented checks.',
    '- `tsconfig.repo-dev.json` and `scripts/package-mode.ts` define explicit repo-dev source overrides.',
    '- `yarn prepare:portable-package` stages a portable source package under `build/portable-source/` without requiring a local install first.',
    '',
    '## Commands',
    '- `yarn build` builds in explicit repo-dev mode against local framework sources.',
    '- `yarn test` runs the local verifier tests in explicit repo-dev mode.',
    '- `yarn verify` runs the generated contract-oriented verifier tests in explicit repo-dev mode.',
    '- `yarn prepare:portable-package` stages a portable source package with versioned framework dev dependencies.',
    '',
  ].join('\n');
}

/**
 * Build the minimal server entrypoint.
 * @param options - Normalized scaffold options.
 * @returns Server entrypoint source.
 */
function buildServerEntrypoint(options: ExtensionScaffoldBuildOptions): string {
  return [
    "import type { MakaioExtension } from '@makaio/contracts';",
    '',
    '/**',
    ' * Minimal server package generated by `makaio extension init`.',
    ' */',
    'const extensionPackage: MakaioExtension = {',
    `  name: ${JSON.stringify(options.name)},`,
    `  displayName: ${JSON.stringify(options.displayName)},`,
    '};',
    '',
    'export default extensionPackage;',
    '',
  ].join('\n');
}

/**
 * Build the minimal browser entrypoint.
 * @returns Browser entrypoint source.
 */
function buildBrowserEntrypoint(): string {
  return [
    "import type { ExtensionBrowserFactory } from '@makaio/ui-kernel';",
    '',
    '/**',
    ' * Minimal browser contribution generated by `makaio extension init`.',
    ' */',
    'const browserContribution: ExtensionBrowserFactory = () => ({});',
    '',
    'export default browserContribution;',
    '',
  ].join('\n');
}

/**
 * Build the minimal CLI entrypoint.
 * @param options - Normalized scaffold options.
 * @returns CLI entrypoint source.
 */
function buildCliEntrypoint(options: ExtensionScaffoldBuildOptions): string {
  return [
    "import { z } from 'zod';",
    "import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';",
    '',
    'const doctor = defineCliSubcommand(',
    "  'doctor',",
    "  'Check that the scaffolded CLI surface is wired correctly',",
    '  z.object({}),',
    '  async ({ output }) => {',
    `    output.write(${JSON.stringify(`${options.name} CLI surface is wired.\n`)});`,
    '  },',
    ');',
    '',
    'const cliContribution: CliContribution = {',
    `  name: ${JSON.stringify(options.name)},`,
    `  description: ${JSON.stringify(`CLI commands for ${options.displayName}`)},`,
    '  subcommands: [doctor],',
    '};',
    '',
    'export default cliContribution;',
    '',
  ].join('\n');
}

/**
 * Build package exports for the selected surfaces.
 * @param surfaces - Selected surfaces.
 * @param directory - Base directory for the export targets.
 * @param filenames - Output filename per surface.
 * @returns Export map object.
 */
function buildSurfaceExports(
  surfaces: readonly ExtensionSurface[],
  directory: 'src' | 'dist',
  filenames: Record<ExtensionSurface, string>,
): Record<string, string> {
  const exports: Record<string, string> = {};
  for (const surface of surfaces) {
    exports[`./${surface}`] = `./${directory}/${filenames[surface]}`;
  }
  return exports;
}

/**
 * Build a workspace link dependency relative to the scaffold root.
 * @param rootDir - Scaffold root directory.
 * @param repoRelativePath - Workspace path relative to the repo root.
 * @returns `link:` dependency string.
 */
function toWorkspaceLink(rootDir: string, repoRelativePath: string): string {
  return `link:${toRelativeImportPath(resolveScaffoldRoot(rootDir), path.join(REPO_ROOT, repoRelativePath))}`;
}

/**
 * Resolve the generated scaffold root against the nearest existing ancestor.
 *
 * This avoids broken relative `link:` targets when the requested output path
 * lives under a symlinked temp directory such as `/var/...` on macOS, which
 * Yarn later resolves through the canonical `/private/var/...` path.
 * @param rootDir - Requested scaffold root directory.
 * @returns Canonicalized absolute scaffold root path.
 */
function resolveScaffoldRoot(rootDir: string): string {
  let existingAncestor = rootDir;
  while (!existsSync(existingAncestor)) {
    const parentDir = path.dirname(existingAncestor);
    if (parentDir === existingAncestor) {
      return rootDir;
    }
    existingAncestor = parentDir;
  }

  const canonicalAncestor = realpathSync.native(existingAncestor);
  return path.join(canonicalAncestor, path.relative(existingAncestor, rootDir));
}

/**
 * Build repo-dev alias entries for the generated tsdown config.
 * @param options - Normalized scaffold options.
 * @returns Multiline object literal entries.
 */
function buildRepoDevAliasEntries(options: ExtensionScaffoldBuildOptions): string {
  const entries = new Map<string, string>([['@makaio/contracts', 'src']]);

  if (options.surfaces.includes('browser')) {
    entries.set('@makaio/ui-kernel', 'src');
  }
  if (options.surfaces.includes('cli')) {
    entries.set('@makaio/kernel', 'src');
  }

  return [...entries.entries()]
    .map(([aliasName, aliasPath]) => `        ${JSON.stringify(aliasName)}: ${JSON.stringify(aliasPath)},`)
    .join('\n');
}
