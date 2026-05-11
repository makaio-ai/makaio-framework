import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyFrameworkDist } from './framework-dist-verifier.js';

/**
 * Writes a JSON file.
 * @param filePath - Absolute file path to write.
 * @param value - JSON-serializable value.
 */
function writeJson(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/**
 * Writes a built file fixture.
 * @param filePath - Absolute file path to write.
 */
function writeBuiltFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
}

describe('verifyFrameworkDist', () => {
  const tempDirs: string[] = [];

  /**
   * Creates a tracked temp directory.
   * @returns Absolute path to the new temp directory.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'framework-dist-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when every publishConfig export target exists', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      publishConfig: {
        exports: {
          './package.json': './package.json',
          './core': {
            types: './dist/core/index.d.mts',
            default: './dist/core/index.mjs',
          },
        },
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.d.mts'));
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root);

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
    expect(result.checkedTargets).toBe(3);
  });

  it('reports missing built export targets', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      publishConfig: {
        exports: {
          './core': {
            types: './dist/core/index.d.mts',
            default: './dist/core/index.mjs',
          },
        },
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'missing-export-target',
        target: './dist/core/index.d.mts',
      }),
    ]);
  });

  it('reports local export targets outside the framework root', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      publishConfig: {
        exports: {
          './escape': '../outside.mjs',
        },
      },
    });

    const result = verifyFrameworkDist(root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './escape',
        kind: 'export-target-outside-root',
        target: '../outside.mjs',
      }),
    ]);
  });

  it('reports export targets that resolve to directories', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      publishConfig: {
        exports: {
          './core': './dist/core',
        },
      },
    });
    mkdirSync(join(root, 'dist/core'), { recursive: true });

    const result = verifyFrameworkDist(root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'export-target-not-file',
        target: './dist/core',
      }),
    ]);
  });
});
