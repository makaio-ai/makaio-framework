import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TsciAnalyzer } from './tsci-analyzer.js';
import { writeFixture, writeWorkspaceTsConfig } from './__test-utils__/fixture-helpers.js';

describe('TsciAnalyzer', () => {
  let workspace: string;
  let analyzer: TsciAnalyzer;
  let fixtureB: string;
  let fixtureC: string;
  let fixtureD: string;
  let fixtureE: string;
  let fixtureF: string;
  let fixtureG: string;
  let scopeDir: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-tsci-analyzer-'));
    scopeDir = workspace;

    writeFixture(workspace, 'fixture-a.ts', [
      'export function util(): void {}',
      'export class Svc { run(): void {} }',
      '',
    ]);

    writeFixture(workspace, 'barrel.ts', ["export { util, Svc } from './fixture-a.js';", '']);

    fixtureB = writeFixture(workspace, 'fixture-b.ts', [
      "import { util, Svc } from './barrel.js';",
      'export const go = () => { util(); };',
      'export function runFree(): void { util(); util(); }',
      'export class Caller {',
      '  exec(svc: Svc): void { svc.run(); util(); }',
      '}',
      '',
    ]);

    fixtureC = writeFixture(workspace, 'fixture-c.ts', [
      "import * as path from 'node:path';",
      'export function doStuff(): string {',
      "  return path.join('a', 'b');",
      '}',
      '',
    ]);

    fixtureD = writeFixture(workspace, 'fixture-d.ts', [
      "import { util } from './barrel.js';",
      'export const value = util();',
      'export class WithField {',
      '  field = util();',
      '  action = () => { util(); };',
      '}',
      '',
    ]);

    fixtureE = writeFixture(workspace, 'fixture-e.ts', [
      "import { util } from './barrel.js';",
      'export function outer(): void {',
      '  const go = () => { util(); };',
      '  go();',
      '}',
      'export const go = () => {};',
      '',
    ]);

    fixtureF = writeFixture(workspace, 'fixture-f.ts', [
      '/**',
      ' * Runs the documented variable function.',
      ' */',
      'export const documented = (): void => {};',
      '',
    ]);

    fixtureG = writeFixture(workspace, 'fixture-g.ts', [
      'export function track(): void {}',
      'function logged(_value?: unknown) {',
      '  return () => undefined;',
      '}',
      'export class Decorated {',
      '  @logged(track())',
      '  run(): void {}',
      '}',
      '',
    ]);

    const tsconfigPath = writeWorkspaceTsConfig(workspace);

    analyzer = new TsciAnalyzer({ tsConfigFilePath: tsconfigPath });
  });

  afterAll(() => {
    analyzer.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  describe('resolveMethodCalls', () => {
    it('resolves calls through barrel re-exports', async () => {
      const targets = await analyzer.resolveMethodCalls(fixtureB, 'Caller', 'exec', scopeDir);

      expect(targets).toContainEqual(
        expect.objectContaining({
          methodName: 'run',
          className: 'Svc',
        }),
      );
      expect(targets).toContainEqual(
        expect.objectContaining({
          methodName: 'util',
          className: null,
        }),
      );
    });

    it('resolves calls from arrow-function variables', async () => {
      const targets = await analyzer.resolveMethodCalls(fixtureB, null, 'go', scopeDir);

      expect(targets).toContainEqual(
        expect.objectContaining({
          methodName: 'util',
          className: null,
        }),
      );
    });
  });

  describe('findSymbolPosition', () => {
    it('locates top-level variable-declared functions as function symbols', async () => {
      const position = await analyzer.findSymbolPosition(fixtureB, 'go', 'function');

      expect(position).toMatchObject({ line: 2 });
    });

    it('locates the indexed top-level variable function when a nested helper has the same name', async () => {
      const position = await analyzer.findSymbolPosition(fixtureE, 'go', 'function');

      expect(position).toMatchObject({ line: 6 });
    });
  });

  describe('extractDocSummary', () => {
    it('extracts JSDoc from top-level variable-declared functions', async () => {
      const summary = await analyzer.extractDocSummary(fixtureF, 'documented', 'function');

      expect(summary).toContain('documented variable function');
    });
  });

  describe('resolveFileCallEdges', () => {
    it('resolves calls from methods, free functions, and arrow-function variables in one file walk', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureB, scopeDir);

      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: null,
          callerName: 'go',
          target: expect.objectContaining({
            methodName: 'util',
            className: null,
          }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: 'Caller',
          callerName: 'exec',
          target: expect.objectContaining({
            methodName: 'run',
            className: 'Svc',
          }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: null,
          callerName: 'runFree',
          target: expect.objectContaining({
            methodName: 'util',
            className: null,
          }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: 'Caller',
          callerName: 'exec',
          target: expect.objectContaining({
            methodName: 'util',
            className: null,
          }),
        }),
      );
    });

    it('includes 1-based call line numbers', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureB, scopeDir);

      for (const edge of edges) {
        expect(edge.callLine).toBeGreaterThan(0);
      }
    });

    it('skips calls resolving outside the scope', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureC, scopeDir);

      expect(edges.find((e) => e.target.methodName === 'join')).toBeUndefined();
    });

    it('deduplicates edges with the same caller and target', async () => {
      // runFree calls util() twice; the public file-edge API reports one
      // caller/target edge, not one edge per call expression.
      const edges = await analyzer.resolveFileCallEdges!(fixtureB, scopeDir);

      const goUtilEdges = edges.filter((e) => e.callerName === 'go' && e.target.methodName === 'util');
      expect(goUtilEdges).toHaveLength(1);
      const freeUtilEdges = edges.filter((e) => e.callerName === 'runFree' && e.target.methodName === 'util');
      expect(freeUtilEdges).toHaveLength(1);
    });

    it('does not attribute plain variable or property initializer calls to function owners', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureD, scopeDir);

      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: null,
          callerName: null,
          callLine: 2,
          target: expect.objectContaining({ methodName: 'util' }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: null,
          callerName: null,
          callLine: 4,
          target: expect.objectContaining({ methodName: 'util' }),
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: 'WithField',
          callerName: 'action',
          callLine: 5,
          target: expect.objectContaining({ methodName: 'util' }),
        }),
      );
    });

    it('attributes nested helper calls to the enclosing indexed caller and skips local helper targets', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureE, scopeDir);

      expect(edges).toContainEqual(
        expect.objectContaining({
          callerClassName: null,
          callerName: 'outer',
          callerDeclarationLine: 2,
          callLine: 3,
          target: expect.objectContaining({ methodName: 'util' }),
        }),
      );
      expect(edges).not.toContainEqual(
        expect.objectContaining({
          callerName: 'go',
          target: expect.objectContaining({ methodName: 'util' }),
        }),
      );
      expect(edges).not.toContainEqual(
        expect.objectContaining({
          callerName: 'outer',
          target: expect.objectContaining({ methodName: 'go' }),
        }),
      );
    });

    it('does not attribute decorator factory calls to decorated methods', async () => {
      const edges = await analyzer.resolveFileCallEdges!(fixtureG, scopeDir);

      expect(edges).not.toContainEqual(
        expect.objectContaining({
          callerClassName: 'Decorated',
          callerName: 'run',
          target: expect.objectContaining({ methodName: 'track' }),
        }),
      );
      expect(edges).not.toContainEqual(
        expect.objectContaining({
          callerClassName: 'Decorated',
          callerName: 'run',
          target: expect.objectContaining({ methodName: 'logged' }),
        }),
      );
    });
  });
});
