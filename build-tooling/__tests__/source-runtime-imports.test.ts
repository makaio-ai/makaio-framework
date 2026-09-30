import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRuntimeImports, hasDynamicImportCall, readManifest } from '../source-runtime-imports.js';

describe('collectRuntimeImports', () => {
  it('keeps runtime declarations and skips type-only ones', () => {
    const source = `
      import def from 'a-default';
      import * as ns from 'b-namespace';
      import { value } from 'c-named';
      import { type T, value2 } from 'd-mixed';
      import 'e-side-effect';
      import fs = require('f-require');
      export { x } from 'g-reexport';
      export * from 'h-star';
      export * as star from 'i-star-ns';
      import { value as again } from 'c-named';

      import type Def from 'type-default';
      import type * as TNs from 'type-namespace';
      import type { U } from 'type-named';
      import { type V, type W } from 'type-all-inline';
      import type req = require('type-require');
      export type { Y } from 'type-export';
      export type * from 'type-export-star';
      export { type Z } from 'type-export-inline';
      export const local = 1;
      const lazy = () => import('not-top-level');
    `;

    expect(collectRuntimeImports(source, 'fixture.ts')).toEqual([
      'a-default',
      'b-namespace',
      'c-named',
      'd-mixed',
      'e-side-effect',
      'f-require',
      'g-reexport',
      'h-star',
      'i-star-ns',
    ]);
  });
});

describe('hasDynamicImportCall', () => {
  it('detects import() calls anywhere in the source', () => {
    expect(hasDynamicImportCall(`const m = () => import('x');`, 'a.ts')).toBe(true);
    expect(hasDynamicImportCall(`async function f() { await import('x'); }`, 'a.ts')).toBe(true);
  });

  it('ignores comments, strings, and static imports', () => {
    const source = `
      import { a } from 'x';
      // import('y')
      /* import('z') */
      const s = "import('w')";
    `;
    expect(hasDynamicImportCall(source, 'a.ts')).toBe(false);
  });
});

describe('readManifest', () => {
  it('reads and parses a package.json path', () => {
    const root = mkdtempSync(join(tmpdir(), 'makaio-source-imports-'));
    try {
      const path = join(root, 'package.json');
      writeFileSync(path, JSON.stringify({ name: 'demo', exports: { '.': './a.ts' } }));
      expect(readManifest(path)).toEqual({ name: 'demo', exports: { '.': './a.ts' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
