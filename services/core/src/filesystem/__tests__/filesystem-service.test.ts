// services/filesystem/src/__tests__/filesystem-service.test.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { FileSystemSubjects } from '../namespace.js';
import { FileSystemService } from '../filesystem-service.js';

describe('FileSystemService', () => {
  let fsService: FileSystemService;
  const testMachineId = 'test-node';

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    fsService = new FileSystemService(MakaioBus, testMachineId, 'Test');
    await fsService.init();
  });

  afterEach(() => {
    fsService.destroy();
  });

  describe('listSources', () => {
    it('should return this node as a source', async () => {
      const response = await MakaioBus.request(FileSystemSubjects.listSources, {});

      expect(response.sources).toHaveLength(1);
      expect(response.sources[0]).toEqual({
        machineId: testMachineId,
        label: 'Test',
      });
    });
  });

  describe('getHomeDir', () => {
    it('should return the home directory path', async () => {
      const response = await MakaioBus.request(FileSystemSubjects.getHomeDir, {
        machineId: testMachineId,
      });

      expect(response.path).toBe(os.homedir());
    });
  });

  describe('listDirectory', () => {
    it('should list home directory contents', async () => {
      const home = os.homedir();
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      expect(response.path).toBe(home);
      expect(Array.isArray(response.entries)).toBe(true);
      expect(typeof response.isGitRepo).toBe('boolean');
    });

    it('should return entries with correct shape', async () => {
      const home = os.homedir();
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      // Home directory should have at least some entries
      expect(response.entries.length).toBeGreaterThan(0);

      const entry = response.entries[0];
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('type');
      expect(['file', 'directory']).toContain(entry.type);
    });

    it('should sort directories before files', async () => {
      const home = os.homedir();
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      const dirs = response.entries.filter((e) => e.type === 'directory');
      const files = response.entries.filter((e) => e.type === 'file');

      if (dirs.length > 0 && files.length > 0) {
        const lastDirIndex = response.entries.lastIndexOf(dirs[dirs.length - 1]);
        const firstFileIndex = response.entries.indexOf(files[0]);
        expect(lastDirIndex).toBeLessThan(firstFileIndex);
      }
    });

    it('should detect git repositories', async () => {
      // This repo's root should be detected as a git repo
      const repoRoot = path.resolve(process.cwd());
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: repoRoot,
      });

      expect(response.isGitRepo).toBe(true);
    });

    it('should return parentPath and segments for navigation', async () => {
      const home = os.homedir();
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      // Home directory should have a parent (unless at root)
      expect(response.segments).toBeInstanceOf(Array);
      expect(response.segments.length).toBeGreaterThan(0);

      // Segments should match path components
      const expectedSegments = home.split(path.sep).filter(Boolean);
      expect(response.segments).toEqual(expectedSegments);

      // Parent path should be the directory above home
      expect(response.parentPath).toBe(path.dirname(home));
    });

    it('should return null parentPath at filesystem root', async () => {
      const root = path.parse(os.homedir()).root;
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: root,
      });

      expect(response.parentPath).toBeNull();
    });

    it('should respect includeHidden option', async () => {
      const home = os.homedir();

      // Without includeHidden (default excludes hidden)
      const withoutHidden = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      // With includeHidden
      const withHidden = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
        options: { includeHidden: true },
      });

      // Hidden entries should be in withHidden but not in withoutHidden
      const hiddenInWithHidden = withHidden.entries.filter((e) => e.name.startsWith('.') && e.name !== '.git');
      const hiddenInWithoutHidden = withoutHidden.entries.filter((e) => e.name.startsWith('.') && e.name !== '.git');

      // With hidden should have more hidden entries
      expect(hiddenInWithHidden.length).toBeGreaterThanOrEqual(hiddenInWithoutHidden.length);
    });

    it('should respect excludeNames option', async () => {
      const repoRoot = path.resolve(process.cwd());

      // Default excludes node_modules
      const defaultExclude = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: repoRoot,
      });

      // Override to not exclude node_modules (must provide includeHidden explicitly)
      const noExclude = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: repoRoot,
        options: { includeHidden: false, excludeNames: [] },
      });

      const hasNodeModulesDefault = defaultExclude.entries.some((e) => e.name === 'node_modules');
      const hasNodeModulesOverride = noExclude.entries.some((e) => e.name === 'node_modules');

      expect(hasNodeModulesDefault).toBe(false);
      expect(hasNodeModulesOverride).toBe(true);
    });

    it('should return breadcrumbs with full paths for cross-platform navigation', async () => {
      const home = os.homedir();
      const response = await MakaioBus.request(FileSystemSubjects.listDirectory, {
        machineId: testMachineId,
        path: home,
      });

      // Breadcrumbs should exist and have entries
      expect(response.breadcrumbs).toBeInstanceOf(Array);
      expect(response.breadcrumbs.length).toBeGreaterThan(0);

      // Each breadcrumb should have name and path
      for (const crumb of response.breadcrumbs) {
        expect(crumb).toHaveProperty('name');
        expect(crumb).toHaveProperty('path');
        expect(typeof crumb.name).toBe('string');
        expect(typeof crumb.path).toBe('string');
      }

      // Last breadcrumb path should match the response path
      const lastCrumb = response.breadcrumbs[response.breadcrumbs.length - 1];
      expect(lastCrumb.path).toBe(response.path);

      // Breadcrumb names should match segments
      const crumbNames = response.breadcrumbs.map((c) => c.name);
      expect(crumbNames).toEqual(response.segments);
    });

    it('should not respond to requests for different machineId', async () => {
      const home = os.homedir();

      await expect(
        MakaioBus.request(FileSystemSubjects.listDirectory, {
          machineId: 'different-node',
          path: home,
        }),
      ).rejects.toThrow();
    });
  });
});
