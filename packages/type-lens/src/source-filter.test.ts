import { describe, expect, it } from 'vitest';
import {
  createTypeviewSourceGlobIgnorePatterns,
  shouldDescendIntoTypeviewSourceDirectory,
  shouldIndexTypeviewSourceFile,
} from './source-filter.js';

describe('Typeview source filter', () => {
  it('indexes source files and excludes tests, declarations, and generated output by default', () => {
    expect(shouldIndexTypeviewSourceFile('src/index.ts')).toBe(true);
    expect(shouldIndexTypeviewSourceFile('src/component.tsx')).toBe(true);

    expect(shouldIndexTypeviewSourceFile('src/index.test.ts')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('src/index.spec.tsx')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('src/Button.stories.tsx')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('src/index.d.ts')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('dist/index.ts')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('node_modules/pkg/index.ts')).toBe(false);
    expect(shouldIndexTypeviewSourceFile('__tests__/index.ts')).toBe(false);
  });

  it('can widen discovery to tests and declarations explicitly', () => {
    expect(shouldIndexTypeviewSourceFile('__tests__/index.ts', { includeTests: true })).toBe(true);
    expect(shouldIndexTypeviewSourceFile('src/index.test.ts', { includeTests: true })).toBe(true);
    expect(shouldIndexTypeviewSourceFile('src/index.d.ts', { includeDeclarationFiles: true })).toBe(true);
  });

  it('keeps generated directories excluded even when tests are included', () => {
    expect(shouldDescendIntoTypeviewSourceDirectory('node_modules', { includeTests: true })).toBe(false);
    expect(shouldDescendIntoTypeviewSourceDirectory('__tests__', { includeTests: true })).toBe(true);
  });

  it('creates glob ignore patterns for filesystem providers and watchers', () => {
    expect(createTypeviewSourceGlobIgnorePatterns()).toEqual(
      expect.arrayContaining(['**/node_modules/**', '**/__tests__/**', '**/*.test.ts', '**/*.d.ts']),
    );
    expect(createTypeviewSourceGlobIgnorePatterns({ includeTests: true })).not.toContain('**/*.test.ts');
    expect(createTypeviewSourceGlobIgnorePatterns({ includeDeclarationFiles: true })).not.toContain('**/*.d.ts');
  });
});
