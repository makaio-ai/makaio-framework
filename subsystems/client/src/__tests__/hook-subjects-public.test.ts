/**
 * Boundary tests for the `@makaio/subsystem-client/hook-subjects` subpath.
 *
 * CLI hook subprocesses import this entrypoint on every client hook event, so
 * it must build the raw hook subjects without evaluating the client subsystem
 * index, its services, or its storage layer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const frameworkRoot = dirname(dirname(packageRoot));
const frameworkPackageRoot = join(frameworkRoot, 'packages', 'framework');
const hookSubjectsSourcePath = join(packageRoot, 'src', 'hook-subjects.ts');

/**
 * The only module the hook-subjects entrypoint may load at runtime. Every
 * other dependency must be a type-only import, which the compiler erases.
 */
const ALLOWED_RUNTIME_IMPORTS = ['zod'] as const;

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
  readonly publishConfig?: { readonly exports?: Record<string, unknown> };
}

/**
 * Read and parse a package manifest.
 * @param root - Directory containing the `package.json`.
 * @returns Parsed manifest.
 */
function readManifest(root: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest;
}

/**
 * Collect the module specifiers a TypeScript source file loads at runtime:
 * value imports, side-effect imports, and `export … from` re-exports. Type-only
 * declarations (`import type`, `export type`) and declarations whose named
 * specifiers are all `type`-qualified are skipped because the compiler erases
 * them.
 * @param source - TypeScript source text.
 * @param fileName - File name used for diagnostics.
 * @returns Sorted, de-duplicated runtime module specifiers.
 */
function collectRuntimeImports(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      const isTypeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!isTypeOnly) specifiers.add(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.exportClause;
      const isTypeOnly =
        statement.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      if (!isTypeOnly) specifiers.add(statement.moduleSpecifier.text);
    }
  }

  return [...specifiers].sort();
}

describe('@makaio/subsystem-client/hook-subjects subpath', () => {
  it('loads no runtime module other than zod', () => {
    const source = readFileSync(hookSubjectsSourcePath, 'utf8');

    expect(collectRuntimeImports(source, hookSubjectsSourcePath)).toEqual([...ALLOWED_RUNTIME_IMPORTS]);
  });

  it('counts value imports, side-effect imports, and re-exports but skips type-only declarations', () => {
    const source = [
      "import { z } from 'zod';",
      "import type { A } from 'type-only-import';",
      "import { type B, type C } from 'type-only-specifiers';",
      "import { type D, e } from 'mixed-specifiers';",
      "import 'side-effect';",
      "export type { F } from 'type-only-reexport';",
      "export { type G } from 'type-only-reexport-specifier';",
      "export { h } from 'value-reexport';",
      "export * from 'star-reexport';",
    ].join('\n');

    expect(collectRuntimeImports(source, 'fixture.ts')).toEqual([
      'mixed-specifiers',
      'side-effect',
      'star-reexport',
      'value-reexport',
      'zod',
    ]);
  });

  it('builds the raw hook subjects', async () => {
    const mod = await import('@makaio/subsystem-client/hook-subjects');

    expect(mod.createRawClientHookReceivedSubject(' Client:Claude-Code ')).toEqual({
      subject: 'hook.received',
      $meta: { namespace: 'client:claude-code', isRequest: false, local: false, channel: false },
    });
    expect(mod.createRawClientHookHandleSubject('client:codex')).toEqual({
      subject: 'hook.handle',
      $meta: { namespace: 'client:codex', isRequest: true, local: false, channel: false, hostLocalRequest: true },
    });
    expect(mod.ClientHookHandleResponseSchema.parse({})).toEqual(mod.NOOP_HOOK_HANDLE_RESPONSE);
    expect('ClientSubjects' in mod).toBe(false);
  }, 15_000);

  it('exposes the subpath in the workspace, publish, and umbrella export maps', () => {
    const clientManifest = readManifest(packageRoot);

    expect(clientManifest.exports).toMatchObject({
      './hook-subjects': './src/hook-subjects.ts',
    });
    expect(clientManifest.publishConfig?.exports).toMatchObject({
      './hook-subjects': './dist/hook-subjects.mjs',
    });
    expect(readManifest(frameworkPackageRoot).exports).toMatchObject({
      './clients/hook-subjects': {
        types: './dist/clients/hook-subjects.d.mts',
        default: './dist/clients/hook-subjects.mjs',
      },
    });
  });
});
