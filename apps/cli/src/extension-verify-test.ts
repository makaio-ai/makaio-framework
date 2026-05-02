import type { ExtensionScaffoldBuildOptions } from './extension-scaffold-files.js';

type SurfaceEntrypoints = Readonly<{
  readonly server?: true | string;
  readonly browser?: true | string;
  readonly cli?: true | string;
}>;

/**
 * Build the generated verification-oriented test.
 * @param options - Normalized scaffold options.
 * @returns Test source.
 */
export function buildVerifyTest(options: ExtensionScaffoldBuildOptions): string {
  const entrypoints = buildDescriptorEntrypoints(options.surfaces);
  const validDistArtifacts = buildValidDistArtifacts(options);

  return [
    buildVerifyTestPreamble(options, entrypoints, validDistArtifacts),
    '',
    buildVerifyTestSuite(options),
    '',
  ].join('\n');
}

/**
 * Build the shared preamble for the generated verification test.
 * @param options - Normalized scaffold options.
 * @param entrypoints - Selected descriptor entrypoints.
 * @param validDistArtifacts - Portable dist fixture contents.
 * @returns Preamble source.
 */
function buildVerifyTestPreamble(
  options: ExtensionScaffoldBuildOptions,
  entrypoints: SurfaceEntrypoints,
  validDistArtifacts: Readonly<Record<string, string>>,
): string {
  return [
    "import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';",
    "import * as os from 'node:os';",
    "import * as path from 'node:path';",
    "import * as url from 'node:url';",
    "import { afterEach, describe, expect, it } from 'vitest';",
    "import { ExtensionDescriptorSchema } from '@makaio/contracts';",
    "import { verifyExtensionWorkspace } from '@makaio/cli';",
    '',
    "const scaffoldRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');",
    `const descriptorEntrypoints = ${JSON.stringify(entrypoints, null, 2)};`,
    `const validDistArtifacts = ${JSON.stringify(validDistArtifacts, null, 2)};`,
    'const tempDirs: string[] = [];',
    '',
    'afterEach(async () => {',
    '  while (tempDirs.length > 0) {',
    '    const tempDir = tempDirs.pop();',
    '    if (tempDir) {',
    '      await rm(tempDir, { recursive: true, force: true });',
    '    }',
    '  }',
    '});',
    '',
    'async function createWorkspaceClone(): Promise<string> {',
    `  const tempDir = await mkdtemp(path.join(os.tmpdir(), '${options.name}-verify-'));`,
    "  const workspaceRoot = path.join(tempDir, 'workspace');",
    '  tempDirs.push(tempDir);',
    '  await cp(scaffoldRoot, workspaceRoot, { recursive: true });',
    '  return workspaceRoot;',
    '}',
    '',
    'async function prepareProdWorkspace(workspaceRoot: string): Promise<void> {',
    "  await rm(path.join(workspaceRoot, 'src'), { recursive: true, force: true });",
    '  await Promise.all(',
    '    Object.entries(validDistArtifacts).map(async ([relativePath, contents]) => {',
    '      const absolutePath = path.join(workspaceRoot, relativePath);',
    '      await mkdir(path.dirname(absolutePath), { recursive: true });',
    "      await writeFile(absolutePath, contents, 'utf8');",
    '    }),',
    '  );',
    '}',
  ].join('\n');
}

/**
 * Build the generated describe block.
 * @param options - Normalized scaffold options.
 * @returns Test suite source.
 */
function buildVerifyTestSuite(options: ExtensionScaffoldBuildOptions): string {
  const sections = [
    buildInvalidDescriptorTest(),
    buildGenericMissingEntrypointTest(options.surfaces),
    buildServerFailureTest(options.surfaces),
    buildCliFailureTest(options.surfaces),
    buildBrowserMissingTest(options.surfaces),
    buildBrowserBareImportTest(options.surfaces),
    buildBrowserStaticRootEscapeTest(options.surfaces),
    buildBrowserInvalidEsmTest(options.surfaces),
    buildPassesTest(),
  ].filter((section): section is string => section !== undefined);

  return ["describe('extension scaffold verifier contract', () => {", ...sections, '});'].join('\n');
}

/**
 * Build the generated invalid descriptor test.
 * @returns Test source.
 */
function buildInvalidDescriptorTest(): string {
  return [
    "  it('rejects invalid descriptor.json', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    await writeFile(path.join(workspaceRoot, 'descriptor.json'), JSON.stringify({ name: 'broken' }, null, 2), 'utf8');",
    '',
    "    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow('descriptor.json is invalid:');",
    '  });',
  ].join('\n');
}

/**
 * Build the generated missing-entrypoint test when one is available.
 * @param surfaces - Selected surfaces.
 * @returns Test source when a generic missing entrypoint applies.
 */
function buildGenericMissingEntrypointTest(surfaces: readonly string[]): string | undefined {
  const surface = surfaces.includes('server') ? 'server' : surfaces.includes('cli') ? 'cli' : undefined;
  if (!surface) {
    return undefined;
  }

  return [
    '',
    `  it('rejects missing declared ${surface} entrypoints', async () => {`,
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    `    await rm(path.join(workspaceRoot, 'dist', '${surface}.mjs'), { force: true });`,
    '',
    `    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(`,
    `      '${surface} entrypoint "${surface}" has no resolvable candidate',`,
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated server export contract test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the server surface is selected.
 */
function buildServerFailureTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('server')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects invalid server default exports', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    await writeFile(path.join(workspaceRoot, './dist/server.mjs'), 'export default {};\\n', 'utf8');",
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    "      'Server entrypoint default export is not a valid MakaioExtension: server',",
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated CLI export contract test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the CLI surface is selected.
 */
function buildCliFailureTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('cli')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects invalid CLI default exports', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    '    await writeFile(',
    "      path.join(workspaceRoot, './dist/cli.mjs'),",
    "      \"export default { name: 'broken', description: 'broken', subcommands: [] };\\n\",",
    "      'utf8',",
    '    );',
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    "      'CLI entrypoint default export is not a valid CliContribution: cli',",
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated browser output presence test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the browser surface is selected.
 */
function buildBrowserMissingTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('browser')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects missing browser build output', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    await rm(path.join(workspaceRoot, './dist/browser.mjs'), { force: true });",
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    '      \'browser entrypoint "browser" has no resolvable candidate\',',
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated browser bare-import test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the browser surface is selected.
 */
function buildBrowserBareImportTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('browser')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects unsupported browser bare imports', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    await writeFile(path.join(workspaceRoot, './dist/browser.mjs'), \"import 'zod';\\nexport default () => ({});\\n\", 'utf8');",
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    "      'Browser entrypoint contains unsupported bare imports: zod.',",
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated browser static-root layout test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the browser surface is selected.
 */
function buildBrowserStaticRootEscapeTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('browser')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects browser bundles that escape the static root', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    await writeFile(path.join(workspaceRoot, 'outside.mjs'), 'export default {};\\n', 'utf8');",
    "    await writeFile(path.join(workspaceRoot, './dist/browser.mjs'), \"import '../outside.mjs';\\nexport default () => ({});\\n\", 'utf8');",
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    "      'Browser entrypoint reaches outside the static root:',",
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated browser graph-validation test.
 * @param surfaces - Selected surfaces.
 * @returns Test source when the browser surface is selected.
 */
function buildBrowserInvalidEsmTest(surfaces: readonly string[]): string | undefined {
  if (!surfaces.includes('browser')) {
    return undefined;
  }

  return [
    '',
    "  it('rejects browser bundles that are not loadable ESM', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    '    await writeFile(',
    "      path.join(workspaceRoot, './dist/browser.mjs'),",
    '      "import \'./missing-chunk.mjs\';\\nexport default () => ({});\\n",',
    "      'utf8',",
    '    );',
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).rejects.toThrow(',
    "      'Browser entrypoint is not parseable/loadable ESM:',",
    '    );',
    '  });',
  ].join('\n');
}

/**
 * Build the generated success-path test.
 * @returns Success-path test source.
 */
function buildPassesTest(): string {
  return [
    '',
    "  it('passes for the generated scaffold once dist outputs satisfy the contract', async () => {",
    '    const workspaceRoot = await createWorkspaceClone();',
    '    await prepareProdWorkspace(workspaceRoot);',
    "    const rawDescriptor = await readFile(path.join(workspaceRoot, 'descriptor.json'), 'utf8');",
    '    const descriptor = ExtensionDescriptorSchema.parse(JSON.parse(rawDescriptor));',
    '',
    '    await expect(verifyExtensionWorkspace({ cwd: workspaceRoot })).resolves.toMatchObject({',
    '      ok: true,',
    '      rootDir: workspaceRoot,',
    '      entrypoints: descriptorEntrypoints,',
    '      diagnostics: [],',
    '    });',
    '    const result = await verifyExtensionWorkspace({ cwd: workspaceRoot });',
    "    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'descriptor', status: 'passed' })]));",
    '    expect(descriptor.entrypoints).toEqual(descriptorEntrypoints);',
    "    expect(descriptor.execution).toBe('embedded');",
    '  });',
  ].join('\n');
}

/**
 * Build the selected descriptor entrypoints.
 * @param surfaces - Selected surfaces.
 * @returns Descriptor entrypoint map.
 */
function buildDescriptorEntrypoints(surfaces: readonly string[]): SurfaceEntrypoints {
  return {
    ...(surfaces.includes('server') ? { server: true as const } : {}),
    ...(surfaces.includes('browser') ? { browser: true as const } : {}),
    ...(surfaces.includes('cli') ? { cli: true as const } : {}),
  };
}

/**
 * Build the reusable valid dist fixtures.
 * @param options - Normalized scaffold options.
 * @returns Portable fixture contents keyed by relative path.
 */
function buildValidDistArtifacts(options: ExtensionScaffoldBuildOptions): Readonly<Record<string, string>> {
  const nameLiteral = JSON.stringify(options.name);
  const displayNameLiteral = JSON.stringify(options.displayName);
  const descriptionLiteral = JSON.stringify(`CLI commands for ${options.displayName}`);

  return {
    ...(options.surfaces.includes('server')
      ? {
          './dist/server.mjs': `export default { name: ${nameLiteral}, displayName: ${displayNameLiteral} };\\n`,
        }
      : {}),
    ...(options.surfaces.includes('browser')
      ? {
          './dist/browser.mjs': "import 'react';\\nexport default () => ({});\\n",
        }
      : {}),
    ...(options.surfaces.includes('cli')
      ? {
          './dist/cli.mjs': `export default { name: ${nameLiteral}, description: ${descriptionLiteral}, subcommands: [{ name: 'doctor', description: 'Check that the scaffolded CLI surface is wired correctly', schema: { safeParse: () => ({ success: true, data: {} }) }, handler: async () => {} }] };\\n`,
        }
      : {}),
  };
}
