/**
 * Unit tests for extractToolFilePath.
 *
 * Verifies path extraction for known filesystem tools, resolution of relative
 * paths, and all null-return edge cases.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { extractToolFilePath } from '../tool-path-extractor.js';

const CWD = '/home/user/project';

describe('extractToolFilePath', () => {
  describe('read_file (args.path)', () => {
    it('resolves a relative path to absolute using cwd', () => {
      const result = extractToolFilePath('read_file', { path: 'src/index.ts' }, CWD);
      expect(result).toBe(path.resolve(CWD, 'src/index.ts'));
    });

    it('normalizes an absolute path', () => {
      const result = extractToolFilePath('read_file', { path: '/abs/path/../path/to/./file.ts' }, CWD);
      expect(result).toBe(path.resolve('/abs/path/../path/to/./file.ts'));
    });

    it('falls back to file_path when path is absent', () => {
      const result = extractToolFilePath('read_file', { file_path: 'src/alt.ts' }, CWD);
      expect(result).toBe(path.resolve(CWD, 'src/alt.ts'));
    });
  });

  describe('Read (args.file_path)', () => {
    it('extracts file_path from Read tool args', () => {
      const result = extractToolFilePath('Read', { file_path: '/some/file.txt' }, CWD);
      expect(result).toBe('/some/file.txt');
    });

    it('resolves a relative file_path against cwd', () => {
      const result = extractToolFilePath('Read', { file_path: 'relative/file.txt' }, CWD);
      expect(result).toBe(path.resolve(CWD, 'relative/file.txt'));
    });
  });

  describe('Write (args.file_path)', () => {
    it('extracts file_path from Write tool args', () => {
      const result = extractToolFilePath('Write', { file_path: '/output/result.json' }, CWD);
      expect(result).toBe('/output/result.json');
    });

    it('prefers path when both path and file_path are present', () => {
      const result = extractToolFilePath('Write', { path: 'primary.txt', file_path: 'secondary.txt' }, CWD);
      expect(result).toBe(path.resolve(CWD, 'primary.txt'));
    });
  });

  describe('Edit (args.file_path)', () => {
    it('extracts file_path from Edit tool args', () => {
      const result = extractToolFilePath('Edit', { file_path: '/workspace/README.md' }, CWD);
      expect(result).toBe('/workspace/README.md');
    });
  });

  describe('null-return cases', () => {
    it('returns null for an unknown tool name', () => {
      const result = extractToolFilePath('bash', { command: 'ls -la' }, CWD);
      expect(result).toBeNull();
    });

    it('returns null when args is undefined', () => {
      const result = extractToolFilePath('read_file', undefined, CWD);
      expect(result).toBeNull();
    });

    it('returns null when all candidate path keys are missing from args', () => {
      const result = extractToolFilePath('read_file', { file_path_legacy: '/some/file.txt' }, CWD);
      expect(result).toBeNull();
    });

    it('returns null when the path value is an empty string', () => {
      const result = extractToolFilePath('read_file', { path: '' }, CWD);
      expect(result).toBeNull();
    });

    it('returns null when toolName is undefined', () => {
      const result = extractToolFilePath(undefined, { path: '/some/file.txt' }, CWD);
      expect(result).toBeNull();
    });

    it('returns null when the path arg value is a non-string type', () => {
      const result = extractToolFilePath('read_file', { path: 42 }, CWD);
      expect(result).toBeNull();
    });
  });
});
