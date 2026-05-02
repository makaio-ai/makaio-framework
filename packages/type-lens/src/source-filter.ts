import * as path from 'node:path';
import { TS_EXTENSIONS } from './index-types.js';

const GENERATED_DIRECTORY_NAMES = new Set([
  '.astro',
  '.git',
  '.next',
  '.tmp',
  '.tsconfigs',
  '.turbo',
  '.typedoc-entrypoints',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const TEST_DIRECTORY_NAMES = new Set(['__fixtures__', '__tests__', 'e2e', 'fixtures', 'test', 'tests']);
const TEST_FILE_PATTERN = /\.(?:test|spec|stories)\.tsx?$/u;
const DECLARATION_FILE_PATTERN = /\.d\.ts$/u;

/** Options controlling Typeview source-file discovery. */
export interface TypeviewSourceFilterOptions {
  /** Include tests, fixtures, and story files. Defaults to false. */
  includeTests?: boolean;
  /** Include `.d.ts` declaration files. Defaults to false. */
  includeDeclarationFiles?: boolean;
}

/** Default glob ignore patterns for Typeview source discovery. */
export const DEFAULT_TYPEVIEW_SOURCE_GLOB_IGNORE_PATTERNS = createTypeviewSourceGlobIgnorePatterns();

/**
 * Decide whether recursive source discovery should enter a directory.
 * @param directoryName - Directory basename.
 * @param options - Source selection options.
 * @returns True when the directory may contain indexable source files.
 */
export function shouldDescendIntoTypeviewSourceDirectory(
  directoryName: string,
  options: TypeviewSourceFilterOptions = {},
): boolean {
  if (GENERATED_DIRECTORY_NAMES.has(directoryName)) return false;
  if (!options.includeTests && TEST_DIRECTORY_NAMES.has(directoryName)) return false;
  return true;
}

/**
 * Decide whether a TypeScript path should be indexed.
 * @param filePath - Absolute or relative candidate file path.
 * @param options - Source selection options.
 * @returns True when the file is part of the source index.
 */
export function shouldIndexTypeviewSourceFile(filePath: string, options: TypeviewSourceFilterOptions = {}): boolean {
  if (!TS_EXTENSIONS.has(path.extname(filePath))) return false;
  if (!options.includeDeclarationFiles && DECLARATION_FILE_PATTERN.test(filePath)) return false;
  if (!options.includeTests && TEST_FILE_PATTERN.test(filePath)) return false;

  const segments = path.normalize(filePath).split(path.sep);
  for (const segment of segments) {
    if (!shouldDescendIntoTypeviewSourceDirectory(segment, options)) return false;
  }
  return true;
}

/**
 * Create glob ignore patterns matching the Typeview source-file filter.
 * @param options - Source selection options.
 * @returns Glob ignore patterns for filesystem providers and watchers.
 */
export function createTypeviewSourceGlobIgnorePatterns(options: TypeviewSourceFilterOptions = {}): string[] {
  const directories = [...GENERATED_DIRECTORY_NAMES];
  if (!options.includeTests) directories.push(...TEST_DIRECTORY_NAMES);

  const patterns = directories.map((name) => `**/${name}/**`);
  if (!options.includeDeclarationFiles) patterns.push('**/*.d.ts');
  if (!options.includeTests) {
    patterns.push(
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.stories.ts',
      '**/*.stories.tsx',
    );
  }
  return patterns;
}
