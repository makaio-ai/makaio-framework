import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shouldSuppressWarning, recordWarningShown } from './warning-debounce.js';

describe('warning-debounce', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(import.meta.dirname!, 'tmp-debounce-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const cwd = '/some/project/dir';

  describe('shouldSuppressWarning', () => {
    it('returns false when no cache file exists', () => {
      expect(shouldSuppressWarning(tmpHome, cwd)).toBe(false);
    });

    it('returns false when cache file is corrupted', () => {
      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');
      fs.mkdirSync(cacheDir, { recursive: true });
      // Write something that matches the hash — we need to figure out the filename,
      // but we can just write a record first and then corrupt it.
      recordWarningShown(tmpHome, cwd);
      // Find the written file and corrupt it.
      const files = fs.readdirSync(cacheDir);
      expect(files).toHaveLength(1);
      fs.writeFileSync(path.join(cacheDir, files[0]!), 'not json');

      expect(shouldSuppressWarning(tmpHome, cwd)).toBe(false);
    });

    it('returns true when warning was recorded recently', () => {
      recordWarningShown(tmpHome, cwd);
      expect(shouldSuppressWarning(tmpHome, cwd)).toBe(true);
    });

    it('returns false when the debounce window has expired', () => {
      recordWarningShown(tmpHome, cwd);

      // Find the cache file and backdate it.
      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');
      const files = fs.readdirSync(cacheDir);
      const filePath = path.join(cacheDir, files[0]!);
      const expired = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      fs.writeFileSync(filePath, JSON.stringify({ lastWarnedAt: expired }));

      expect(shouldSuppressWarning(tmpHome, cwd)).toBe(false);
    });

    it('isolates different CWDs', () => {
      recordWarningShown(tmpHome, '/project/a');
      expect(shouldSuppressWarning(tmpHome, '/project/a')).toBe(true);
      expect(shouldSuppressWarning(tmpHome, '/project/b')).toBe(false);
    });
  });

  describe('recordWarningShown', () => {
    it('creates the cache directory and file', () => {
      recordWarningShown(tmpHome, cwd);

      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');
      const files = fs.readdirSync(cacheDir);
      expect(files).toHaveLength(1);

      const data = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]!), 'utf-8'));
      expect(data.lastWarnedAt).toBeTypeOf('number');
      expect(Date.now() - data.lastWarnedAt).toBeLessThan(1000);
    });

    it('overwrites a previous record', () => {
      recordWarningShown(tmpHome, cwd);

      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');
      const files = fs.readdirSync(cacheDir);
      const filePath = path.join(cacheDir, files[0]!);

      // Backdate and then re-record.
      fs.writeFileSync(filePath, JSON.stringify({ lastWarnedAt: 0 }));
      recordWarningShown(tmpHome, cwd);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(Date.now() - data.lastWarnedAt).toBeLessThan(1000);
    });

    it('does not throw when the home directory is read-only', () => {
      // Use a path that can't be created (nested under a file, not a dir).
      const fakePath = path.join(tmpHome, 'a-file');
      fs.writeFileSync(fakePath, 'block');

      expect(() => recordWarningShown(fakePath, cwd)).not.toThrow();
    });

    it('evicts stale cache files on write', () => {
      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');

      // Create entries for several CWDs, then backdate all but the current one.
      recordWarningShown(tmpHome, '/old/project/a');
      recordWarningShown(tmpHome, '/old/project/b');

      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        fs.writeFileSync(filePath, JSON.stringify({ lastWarnedAt: Date.now() - 6 * 60 * 1000 }));
      }

      // Recording a new warning should evict the stale entries.
      recordWarningShown(tmpHome, cwd);

      const remaining = fs.readdirSync(cacheDir);
      expect(remaining).toHaveLength(1);
    });

    it('evicts corrupted cache files during cleanup', () => {
      const cacheDir = path.join(tmpHome, 'cache', 'cli-warnings');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'garbage.json'), 'not json');

      recordWarningShown(tmpHome, cwd);

      const remaining = fs.readdirSync(cacheDir);
      expect(remaining).toHaveLength(1);
      // The remaining file is the one we just wrote, not the garbage.
      expect(remaining[0]).not.toBe('garbage.json');
    });
  });
});
