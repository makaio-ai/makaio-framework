import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const contractsRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(contractsRoot);
const forbiddenRuntimeDeps = ['@makaio/bus-core', '@makaio/storage-core', '@makaio/utils'] as const;
const runtimeDependencyFields = [
  'dependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
] as const;

type RuntimeDependencyField = (typeof runtimeDependencyFields)[number];
type DependencyDeclaration = Record<string, string> | readonly string[];

/**
 * Escape a string for use inside a regular expression.
 * @param value - Literal string to escape.
 * @returns Regex-safe version of the value.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect runtime imports that would cross the package boundary.
 * @param source - Source text to inspect.
 * @param dependency - Forbidden dependency package name.
 * @returns True when the source imports the dependency or one of its subpaths.
 */
function hasForbiddenImport(source: string, dependency: string): boolean {
  const escapedDependency = escapeRegExp(dependency);
  const specifier = `${escapedDependency}(?:/[^'"\`]*)?`;
  return new RegExp(
    [
      `from\\s*['"]${specifier}['"]`,
      `import\\s*['"]${specifier}['"]`,
      `import\\s*\\(\\s*['"]${specifier}['"]\\s*\\)`,
      `import\\s*\\(\\s*\`${specifier}\`\\s*\\)`,
      `require\\s*\\(\\s*['"]${specifier}['"]\\s*\\)`,
      `require\\s*\\(\\s*\`${specifier}\`\\s*\\)`,
    ].join('|'),
  ).test(source);
}

/**
 * Check whether a package dependency field declares a dependency.
 * @param declaration - Package dependency declaration field to inspect.
 * @param dependency - Dependency package name to find.
 * @returns True when the field declares the dependency.
 */
function declaresDependency(declaration: DependencyDeclaration | undefined, dependency: string): boolean {
  if (Array.isArray(declaration)) return declaration.includes(dependency);
  return Object.prototype.hasOwnProperty.call(declaration ?? {}, dependency);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__') return [];
      return listSourceFiles(fullPath);
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) return [];
    return [fullPath];
  });
}

describe('@makaio/contracts package boundary', () => {
  it('detects forbidden import syntaxes including dynamic template specifiers', () => {
    expect(hasForbiddenImport("import '@makaio/bus-core';", '@makaio/bus-core')).toBe(true);
    expect(hasForbiddenImport("await import('@makaio/storage-core/sqlite');", '@makaio/storage-core')).toBe(true);
    expect(hasForbiddenImport('await import(`@makaio/utils/path`);', '@makaio/utils')).toBe(true);
    expect(hasForbiddenImport('require(`@makaio/bus-core/${target}`);', '@makaio/bus-core')).toBe(true);
    expect(hasForbiddenImport('await import(`@makaio/bus-core-extra`);', '@makaio/bus-core')).toBe(false);
  });

  it('detects forbidden runtime dependency declarations across package fields', () => {
    expect(declaresDependency({ '@makaio/bus-core': 'workspace:*' }, '@makaio/bus-core')).toBe(true);
    expect(declaresDependency(['@makaio/storage-core'], '@makaio/storage-core')).toBe(true);
    expect(declaresDependency(['@makaio/storage-core-extra'], '@makaio/storage-core')).toBe(false);
  });

  it('does not declare runtime dependencies on bus, storage, or utility implementation packages', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Partial<
      Record<RuntimeDependencyField, DependencyDeclaration>
    >;

    for (const dependency of forbiddenRuntimeDeps) {
      for (const field of runtimeDependencyFields) {
        expect(declaresDependency(pkg[field], dependency), `${field} declares ${dependency}`).toBe(false);
      }
    }
  });

  it('does not import implementation packages from production source files', () => {
    const violations = listSourceFiles(contractsRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenRuntimeDeps
        .filter((dependency) => hasForbiddenImport(source, dependency))
        .map((dependency) => `${relative(packageRoot, file)} imports ${dependency}`);
    });

    expect(violations).toEqual([]);
  });
});
