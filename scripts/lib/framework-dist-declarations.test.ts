import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBusBundlesNoCoreRuntime, checkBusDeclaresNoCoreTypes } from './framework-dist-declarations.js';
import { type FrameworkDistIssue, verifyFrameworkDist } from './framework-dist-verifier.js';

/** Long, prose-like literal that survives the fingerprint filter of the runtime check. */
const CORE_LITERAL = 'the call context was not minted by the kernel';

/** Second long literal, to show that every fingerprint is matched on its own. */
const OTHER_CORE_LITERAL = 'a party reference must name a registered carrier';

const tempDirs: string[] = [];

/**
 * Creates a tracked, empty temp package root.
 * @returns Absolute path to the new root.
 */
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'framework-dist-declarations-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes a file below the root, creating parent directories.
 * @param root - Package root.
 * @param relativePath - Path below the root.
 * @param content - File content.
 */
function write(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Runs the declaration check on a root.
 * @param root - Package root.
 * @returns Issues found.
 */
function declarationIssues(root: string): FrameworkDistIssue[] {
  const issues: FrameworkDistIssue[] = [];
  checkBusDeclaresNoCoreTypes(root, issues);
  return issues;
}

/**
 * Runs the runtime check on a root.
 * @param root - Package root.
 * @returns Issues found.
 */
function runtimeIssues(root: string): FrameworkDistIssue[] {
  const issues: FrameworkDistIssue[] = [];
  checkBusBundlesNoCoreRuntime(root, issues);
  return issues;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkBusDeclaresNoCoreTypes', () => {
  const coreDeclarations =
    'declare class CallContext {}\ninterface Party {}\nexport { CallContext, type Party as PartyRef };\n';

  it('reports a bus declaration that declares a name the core exports', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(root, 'dist/bus/index.d.mts', 'declare class CallContext {}\nexport { CallContext };\n');

    expect(declarationIssues(root)).toEqual([
      expect.objectContaining({
        exportKey: 'CallContext',
        kind: 'bus-declares-core-type',
        target: 'dist/bus/index.d.mts',
      }),
    ]);
  });

  it('matches the alias of an `export { x as y }` list entry', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(root, 'dist/bus/index.d.mts', 'export interface PartyRef {}\n');

    expect(declarationIssues(root)).toEqual([expect.objectContaining({ exportKey: 'PartyRef' })]);
  });

  it('does not report the original name of an aliased core export', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(root, 'dist/bus/index.d.mts', 'interface Party {}\nexport { Party };\n');

    expect(declarationIssues(root)).toEqual([]);
  });

  it('reports a name once per bundle however often it is declared', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(root, 'dist/bus/index.d.mts', 'declare class CallContext {}\ndeclare const CallContext: number;\n');

    expect(declarationIssues(root)).toHaveLength(1);
  });

  it('finds bundles in nested bus directories', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(root, 'dist/bus/nested/chunk.d.ts', 'declare class CallContext {}\n');

    expect(declarationIssues(root)).toEqual([expect.objectContaining({ target: 'dist/bus/nested/chunk.d.ts' })]);
  });

  it('accepts a name that the bus only imports', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(
      root,
      'dist/bus/index.d.mts',
      "import { CallContext } from '@makaio/framework/core';\ndeclare class Bus { call: CallContext }\nexport { Bus };\n",
    );

    expect(declarationIssues(root)).toEqual([]);
  });

  it('ignores indented members and TSDoc examples', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    write(
      root,
      'dist/bus/index.d.mts',
      [
        'declare class Bus {',
        '  interface CallContext {}',
        '  type CallContext = string;',
        '}',
        '/**',
        ' * @example',
        ' * declare class CallContext {}',
        ' */',
        'export { Bus };',
        '',
      ].join('\n'),
    );

    expect(declarationIssues(root)).toEqual([]);
  });

  it('does not find a declaration glued to the previous line (documented limit)', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.d.mts', coreDeclarations);
    // The anchor is the line start, so `declare class CallContext {}` after a
    // semicolon on the same line is invisible. The declaration bundler emits one
    // declaration per line; this pins the limit rather than claiming coverage.
    write(root, 'dist/bus/index.d.mts', 'declare const marker: 1; declare class CallContext {}\n');

    expect(declarationIssues(root)).toEqual([]);
  });

  it('does nothing when the core declarations or the bus directory are missing', () => {
    const withoutBus = makeRoot();
    write(withoutBus, 'dist/core/index.d.mts', coreDeclarations);
    const withoutCore = makeRoot();
    write(withoutCore, 'dist/bus/index.d.mts', 'declare class CallContext {}\n');

    expect(declarationIssues(withoutBus)).toEqual([]);
    expect(declarationIssues(withoutCore)).toEqual([]);
  });
});

describe('checkBusBundlesNoCoreRuntime', () => {
  const coreRuntime = `export const a=new Error("${CORE_LITERAL}");export const b=new Error("${OTHER_CORE_LITERAL}");`;

  it('passes a distribution whose bus runtime imports the core', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.mjs', coreRuntime);
    write(root, 'dist/bus/index.mjs', 'import{a}from"@makaio/framework/core";export const c=a;');

    expect(runtimeIssues(root)).toEqual([]);
  });

  it('reports a bus chunk that carries a core literal', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.mjs', coreRuntime);
    write(root, 'dist/bus/chunks/inlined.mjs', `const x="${CORE_LITERAL}";export{x};`);

    expect(runtimeIssues(root)).toEqual([
      expect.objectContaining({
        exportKey: CORE_LITERAL,
        kind: 'bus-bundles-core-runtime',
        target: 'dist/bus/chunks/inlined.mjs',
      }),
    ]);
  });

  it('reports each core literal of a chunk and leaves clean chunks alone', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.mjs', coreRuntime);
    write(root, 'dist/bus/a.mjs', `const x="${CORE_LITERAL}",y="${OTHER_CORE_LITERAL}";export{x,y};`);
    write(root, 'dist/bus/b.mjs', 'export const z=1;');

    const issues = runtimeIssues(root);

    expect(issues.map((issue) => issue.exportKey).sort()).toEqual([CORE_LITERAL, OTHER_CORE_LITERAL].sort());
    expect(issues.every((issue) => issue.target === 'dist/bus/a.mjs')).toBe(true);
  });

  it('ignores literals in non-runtime files of the bus directory', () => {
    const root = makeRoot();
    write(root, 'dist/core/index.mjs', coreRuntime);
    write(root, 'dist/bus/index.d.mts', `declare const x: "${CORE_LITERAL}";\n`);

    expect(runtimeIssues(root)).toEqual([]);
  });

  it('reports exactly one unverified issue when the core has no long literal', () => {
    const root = makeRoot();
    // Short literals and a mis-paired code fragment must not count as fingerprints.
    write(
      root,
      'dist/core/index.mjs',
      'export const a="short";const b=`x${1}`;const c="a=b;c{d}e padded to be long enough";',
    );
    write(root, 'dist/bus/index.mjs', 'export const z=1;');

    expect(runtimeIssues(root)).toEqual([
      expect.objectContaining({
        exportKey: 'dist/core/index.mjs',
        kind: 'bus-bundles-core-runtime',
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('does nothing when the core runtime or the bus directory are missing', () => {
    const withoutBus = makeRoot();
    write(withoutBus, 'dist/core/index.mjs', coreRuntime);
    const withoutCore = makeRoot();
    write(withoutCore, 'dist/bus/index.mjs', `const x="${CORE_LITERAL}";`);

    expect(runtimeIssues(withoutBus)).toEqual([]);
    expect(runtimeIssues(withoutCore)).toEqual([]);
  });

  describe('through verifyFrameworkDist without expected declarations', () => {
    /**
     * Writes a runtime-only package whose bus chunk carries the given content.
     * @param busContent - Content of `dist/bus/index.mjs`.
     * @returns Package root.
     */
    function makeRuntimeOnlyRoot(busContent: string): string {
      const root = makeRoot();
      write(
        root,
        'package.json',
        JSON.stringify({
          exports: {
            './core': { default: './dist/core/index.mjs' },
            './bus': { default: './dist/bus/index.mjs' },
          },
        }),
      );
      write(root, 'dist/core/index.mjs', coreRuntime);
      write(root, 'dist/bus/index.mjs', busContent);
      return root;
    }

    it('still runs the runtime check', () => {
      const root = makeRuntimeOnlyRoot(`export const x="${CORE_LITERAL}";`);

      const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [], runtimeAssets: [] });

      expect(result.issues).toEqual([expect.objectContaining({ kind: 'bus-bundles-core-runtime' })]);
    });

    it('passes a clean bus runtime', () => {
      const root = makeRuntimeOnlyRoot('export const x=1;');

      const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [], runtimeAssets: [] });

      expect(result.issues).toEqual([]);
    });
  });
});
