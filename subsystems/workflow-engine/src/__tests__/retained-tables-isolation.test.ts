import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { workflowEngineSchema } from '../storage/schema.variants.js';

type ExportTarget = string | null | readonly ExportTarget[] | { readonly [key: string]: ExportTarget };

interface WorkflowEngineManifest {
  readonly name: string;
  readonly exports: Readonly<Record<string, ExportTarget>>;
  readonly makaio: {
    readonly drizzleSchema: { readonly sqlite: readonly string[]; readonly postgres: readonly string[] };
  };
}

interface ModuleReferences {
  readonly specifiers: string[];
  readonly nonLiteralCalls: string[];
}

const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const packageRoot = dirname(manifestPath);
const sourceRoot = resolve(packageRoot, 'src');
const repositoryRoot = resolve(packageRoot, '../..');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkflowEngineManifest;
const retainedSqlite = resolve(sourceRoot, 'storage/retained-tables.ts');
const retainedPostgres = resolve(sourceRoot, 'storage/retained-tables.postgres.ts');
const retainedModules = new Set([retainedSqlite, retainedPostgres]);
// The migration generator materializes the two manifest entry lists at these paths.
const generatedSqliteSchema = resolve(repositoryRoot, 'storage/migrations/.generated/schema.ts');
const generatedPostgresSchema = resolve(repositoryRoot, 'storage/migrations/.generated/schema.postgres.ts');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const builtOutputDirectories = new Set([
  resolve(repositoryRoot, 'apps/electrobun/build'),
  resolve(repositoryRoot, 'packages/framework/dist'),
  resolve(repositoryRoot, 'packages/framework/lib'),
]);
const resolutionOptions: ts.CompilerOptions = {
  allowJs: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};
const resolutionCache = ts.createModuleResolutionCache(repositoryRoot, (filename) => filename, resolutionOptions);

/**
 * Enumerate source-like files outside installed dependencies and compiled distributions.
 * @param directory - Directory to walk.
 * @returns Source filenames under the directory.
 */
function* sourceFiles(directory: string): Iterable<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = resolve(directory, entry.name);
    if (
      entry.isDirectory() &&
      entry.name !== 'node_modules' &&
      entry.name !== '.git' &&
      !builtOutputDirectories.has(filename)
    ) {
      yield* sourceFiles(filename);
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      yield filename;
    }
  }
}

/**
 * Find the module expression in declarations, type imports, and loader calls.
 * @param node - Current syntax-tree node.
 * @returns Module expression or `undefined` for other syntax.
 */
function moduleExpression(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  return undefined;
}

/**
 * Identify the two loader calls that require a literal module argument.
 * @param node - Current syntax-tree node.
 * @returns Whether this is an import or require call.
 */
function isLoaderCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

/**
 * Read module references from source without executing it.
 * @param filename - Filename used to select the source language and report locations.
 * @param contents - Source text to parse.
 * @returns Literal specifiers and locations of unresolved loader calls.
 */
function readModuleReferences(filename: string, contents: string): ModuleReferences {
  const source = ts.createSourceFile(filename, contents, ts.ScriptTarget.Latest);
  const specifiers: string[] = [];
  const nonLiteralCalls: string[] = [];

  /**
   * Visit references even when they are nested inside declarations or expressions.
   * @param node - Current syntax-tree node.
   */
  function visit(node: ts.Node): void {
    const loaderCall = isLoaderCall(node);
    const target = loaderCall ? node.arguments[0] : moduleExpression(node);
    if (target !== undefined && ts.isStringLiteralLike(target)) {
      specifiers.push(target.text);
    } else if (loaderCall) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      nonLiteralCalls.push(`${relative(repositoryRoot, filename)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return { specifiers, nonLiteralCalls };
}

/**
 * Collect paths from all declared export conditions and fallbacks.
 * @param target - Package export target.
 * @returns Declared file path targets.
 */
function exportPaths(target: ExportTarget): string[] {
  if (typeof target === 'string') return [target];
  if (target === null) return [];
  return Object.values(target).flatMap(exportPaths);
}

/**
 * Resolve a relative specifier using TypeScript's source-file and index lookup.
 * @param specifier - Relative module specifier.
 * @param importer - Absolute filename of the importing file.
 * @returns Absolute resolved filename when found.
 */
function resolveSource(specifier: string, importer: string): string | undefined {
  const filename = ts.resolveModuleName(specifier, importer, resolutionOptions, ts.sys, resolutionCache).resolvedModule
    ?.resolvedFileName;
  return filename === undefined ? undefined : resolve(filename);
}

/**
 * Read the path segment substituted for a package export wildcard.
 * @param pattern - Package export key or target pattern.
 * @param path - Concrete path to match.
 * @returns Wildcard segment when the pattern matches.
 */
function wildcardMatch(pattern: string, path: string): string | undefined {
  const index = pattern.indexOf('*');
  if (index === -1) return undefined;
  const prefix = pattern.slice(0, index);
  const suffix = pattern.slice(index + 1);
  if (!path.startsWith(prefix) || !path.endsWith(suffix) || path.length < prefix.length + suffix.length)
    return undefined;
  return path.slice(prefix.length, path.length - suffix.length);
}

/**
 * Resolve references through the engine's public package exports or relative source paths.
 * @param importer - Absolute filename of the importing file.
 * @param specifiers - Literal module specifiers used by the file.
 * @param exports - Export map to resolve engine package aliases through.
 * @returns The protected modules reached by the references.
 */
function resolveRetainedImports(
  importer: string,
  specifiers: readonly string[],
  exports: WorkflowEngineManifest['exports'] = manifest.exports,
): string[] {
  const resolved = specifiers.flatMap((specifier) => {
    if (ts.isExternalModuleNameRelative(specifier)) {
      // All protected targets have a fixed filename stem. Skip unrelated lookups.
      const candidate = resolve(dirname(importer), specifier).replace(/\.(?:js|ts)$/, '');
      return retainedModules.has(`${candidate}.ts`) ? [resolveSource(specifier, importer)] : [];
    }
    if (specifier !== manifest.name && !specifier.startsWith(`${manifest.name}/`)) return [];

    const subpath = `.${specifier.slice(manifest.name.length)}`;
    if (Object.hasOwn(exports, subpath)) {
      return exportPaths(exports[subpath]).map((path) => resolveSource(path, manifestPath));
    }
    return Object.entries(exports).flatMap(([pattern, target]) => {
      const match = wildcardMatch(pattern, subpath);
      if (match === undefined) return [];
      return exportPaths(target).map((path) => resolveSource(path.replaceAll('*', match), manifestPath));
    });
  });
  return resolved.filter((path): path is string => path !== undefined && retainedModules.has(path));
}

/**
 * Check whether an export target exposes either retained module under any subpath.
 * @param target - Export target path relative to the package.
 * @returns Whether this direct or wildcard target exposes a retained module.
 */
function exposesRetainedModule(target: string): boolean {
  if (!target.includes('*')) {
    const resolved = resolveSource(target, manifestPath);
    return resolved !== undefined && retainedModules.has(resolved);
  }
  return [...retainedModules].some((filename) => {
    const stem = `./${relative(packageRoot, filename).split(sep).join('/').slice(0, -3)}`;
    return [stem, `${stem}.js`, `${stem}.ts`].some((path) => wildcardMatch(target, path) !== undefined);
  });
}

describe('retained workflow tables', () => {
  const filesByArea = Map.groupBy(sourceFiles(repositoryRoot), (filename) => {
    const directories = dirname(relative(repositoryRoot, filename)).split(sep);
    return directories[0] ?? '.';
  });

  it.each([...filesByArea])('keeps retained table imports isolated in %s', (_area, files) => {
    const sqliteImporters = new Set<string>();
    const postgresImporters = new Set<string>();
    const opaqueEngineImports: string[] = [];

    for (const filename of files) {
      const { specifiers, nonLiteralCalls } = readModuleReferences(filename, readFileSync(filename, 'utf8'));
      if (filename.startsWith(`${sourceRoot}${sep}`)) opaqueEngineImports.push(...nonLiteralCalls);
      const targets = resolveRetainedImports(filename, specifiers);
      const importer = relative(packageRoot, filename);
      if (targets.includes(retainedSqlite) && filename !== generatedSqliteSchema) sqliteImporters.add(importer);
      if (targets.includes(retainedPostgres) && filename !== generatedPostgresSchema) postgresImporters.add(importer);
    }

    expect(opaqueEngineImports).toEqual([]);
    expect([...sqliteImporters]).toEqual(
      files.includes(retainedPostgres) ? [relative(packageRoot, retainedPostgres)] : [],
    );
    expect([...postgresImporters]).toEqual([]);
  });

  it('excludes retained attempt tables from the runtime schema of either dialect', () => {
    const retained = [
      'activeExecutionAttempts',
      'executionAttemptCancellations',
      'executionAttemptControlEvidence',
      'executionAttemptRequests',
      'executionAttempts',
      'providerOperations',
    ];
    for (const table of retained) {
      expect(workflowEngineSchema.sqlite, table).not.toHaveProperty(table);
      expect(workflowEngineSchema.postgres, table).not.toHaveProperty(table);
    }
  });

  it('keeps the retained modules private and registered for migration generation', () => {
    expect([...filesByArea.values()].flat()).toContain(retainedPostgres);
    const retainedExports = Object.entries(manifest.exports).filter(([, target]) =>
      exportPaths(target).some(exposesRetainedModule),
    );
    expect(retainedExports).toEqual([]);
    expect(manifest.makaio.drizzleSchema.sqlite).toContain('./src/storage/retained-tables.ts');
    expect(manifest.makaio.drizzleSchema.postgres).toContain('./src/storage/retained-tables.postgres.ts');
  });

  const probeFile = resolve(sourceRoot, '__tests__/isolation-probe.ts');

  it.each([
    "import { table } from '<target>';",
    "import '<target>';",
    "import tables = require('<target>');",
    "void import('<target>');",
    "const tables = require('<target>');",
    "export { table } from '<target>';",
    "export * from '<target>';",
    "type Table = import('<target>').Table;",
  ])('finds the retained import in %s', (probe) => {
    const { specifiers } = readModuleReferences(probeFile, probe.replace('<target>', '../storage/retained-tables.js'));
    expect(resolveRetainedImports(probeFile, specifiers)).toEqual([retainedSqlite]);
  });

  it('finds an extensionless target and an engine package alias', () => {
    const source = `import '../storage/retained-tables'; import '${manifest.name}/example';`;
    const exports = { './example': { import: './src/storage/retained-tables.postgres.js' } };
    const { specifiers } = readModuleReferences(probeFile, source);
    expect(resolveRetainedImports(probeFile, specifiers, exports)).toEqual([retainedSqlite, retainedPostgres]);
  });

  it('resolves directory indexes and detects wildcard exports of retained modules', () => {
    expect(resolveSource('..', probeFile)).toBe(resolve(sourceRoot, 'index.ts'));
    const exports = { './storage/*': './src/storage/*' };
    expect(resolveRetainedImports(probeFile, [`${manifest.name}/storage/retained-tables.js`], exports)).toEqual([
      retainedSqlite,
    ]);
    expect(exposesRetainedModule(exports['./storage/*'])).toBe(true);
  });

  it('flags non-literal loader calls', () => {
    const source = 'const target = "./schema.js";\nvoid import(target);\nrequire(target);';
    const result = readModuleReferences(probeFile, source);
    expect(result).toEqual({
      specifiers: [],
      nonLiteralCalls: [`${relative(repositoryRoot, probeFile)}:2`, `${relative(repositoryRoot, probeFile)}:3`],
    });
  });

  it('ignores unrelated imports and source text that only resembles an import', () => {
    const source = "import '../storage/schema.js'; const example = \"require('../storage/retained-tables.js')\";";
    const { specifiers } = readModuleReferences(probeFile, source);
    expect(resolveRetainedImports(probeFile, specifiers)).toEqual([]);
  });
});
