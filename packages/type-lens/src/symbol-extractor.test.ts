import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { extractFunctions } from './symbol-extractor.js';

/**
 * Create an in-memory ts-morph source file and extract function symbols from it.
 * @param code - TypeScript source text
 * @returns Array of extracted function symbol nodes
 */
function parseFixture(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('fixture.ts', code);
  return extractFunctions(sourceFile, 'fixture.ts');
}

describe('extractFunctions', () => {
  describe('function declarations', () => {
    it('extracts a named exported function declaration', () => {
      const symbols = parseFixture('export function greet(name: string): string { return name; }');
      const fn = symbols.find((s) => s.name === 'greet');
      expect(fn).toMatchObject({
        kind: 'function',
        isExported: true,
      });
      expect(fn?.signature).toContain('(name: string)');
    });

    it('extracts a non-exported function declaration', () => {
      const symbols = parseFixture('function internal(x: number): number { return x; }');
      expect(symbols.find((s) => s.name === 'internal')).toMatchObject({
        kind: 'function',
        isExported: false,
      });
    });

    it('skips bodyless overload stubs', () => {
      const symbols = parseFixture(
        [
          'export function overloaded(x: string): string;',
          'export function overloaded(x: number): number;',
          'export function overloaded(x: string | number): string | number { return x; }',
        ].join('\n'),
      );
      const matches = symbols.filter((s) => s.name === 'overloaded');
      expect(matches).toHaveLength(1);
    });
  });

  describe('variable-declared functions', () => {
    it('extracts exported const arrow functions as function symbols', () => {
      const symbols = parseFixture('export const handler = (req: Request): Response => { return new Response(); };');
      const fn = symbols.find((s) => s.name === 'handler');
      expect(fn).toMatchObject({ kind: 'function', isExported: true });
      expect(fn?.signature).toContain('(req: Request)');
    });

    it('extracts non-exported function-expression variables', () => {
      const symbols = parseFixture('const helper = function (x: number) { return x * 2; };');
      expect(symbols.find((s) => s.name === 'helper')).toMatchObject({
        kind: 'function',
        isExported: false,
      });
    });

    it('extracts exported function expressions', () => {
      const symbols = parseFixture('export const create = function create(n: string): void {};');
      const fn = symbols.find((s) => s.name === 'create');
      expect(fn).toMatchObject({ kind: 'function', isExported: true });
      expect(fn?.signature).toContain('(n: string)');
    });

    it('does not extract non-function variables', () => {
      const symbols = parseFixture('export const config = { retries: 3 };');
      expect(symbols.find((s) => s.name === 'config')).toBeUndefined();
    });

    it('does not extract non-function const primitives', () => {
      const symbols = parseFixture('export const MAX = 100;');
      expect(symbols.find((s) => s.name === 'MAX')).toBeUndefined();
    });

    it('reports the line number of the variable declaration', () => {
      const symbols = parseFixture(['// header comment', 'export const fn = () => {};'].join('\n'));
      const fn = symbols.find((s) => s.name === 'fn');
      expect(fn?.line).toBe(2);
    });

    it('skips variable-declared functions inside nested scopes', () => {
      const symbols = parseFixture(
        ['function outer() {', '  const inner = () => {};', '  return inner;', '}'].join('\n'),
      );
      // 'outer' should be found (function declaration), 'inner' should NOT
      expect(symbols.find((s) => s.name === 'outer')).toBeDefined();
      expect(symbols.find((s) => s.name === 'inner')).toBeUndefined();
    });
  });
});
