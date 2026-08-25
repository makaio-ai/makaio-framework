import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodeExecutionScratch, type CodeExecutionScratch } from './execution-fixtures.js';

const TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

type TemporaryDirectoryEnvironmentKey = (typeof TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS)[number];
type TemporaryDirectoryEnvironment = Readonly<Record<TemporaryDirectoryEnvironmentKey, string | undefined>>;

const snapshotTemporaryDirectoryEnvironment = (): TemporaryDirectoryEnvironment => ({
  TMPDIR: process.env['TMPDIR'],
  TEMP: process.env['TEMP'],
  TMP: process.env['TMP'],
});

const restoreTemporaryDirectoryEnvironment = (environment: TemporaryDirectoryEnvironment): void => {
  for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const clearTemporaryDirectoryEnvironment = (): void => {
  for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) {
    delete process.env[key];
  }
};

describe('createCodeExecutionScratch', () => {
  it('rejects a witness prefix that escapes the scratch workspace', async () => {
    const environmentBeforeTest = snapshotTemporaryDirectoryEnvironment();
    let scratch: CodeExecutionScratch | undefined;

    try {
      const currentScratch = await createCodeExecutionScratch();
      scratch = currentScratch;

      expect(() => currentScratch.path('../outside')).toThrow(
        'A scratch path prefix must not escape the workspace root.',
      );
    } finally {
      await scratch?.dispose();
      restoreTemporaryDirectoryEnvironment(environmentBeforeTest);
    }
  });

  it('restores temporary-directory variables that were originally absent', async () => {
    const environmentBeforeTest = snapshotTemporaryDirectoryEnvironment();
    let scratch: CodeExecutionScratch | undefined;

    try {
      clearTemporaryDirectoryEnvironment();
      scratch = await createCodeExecutionScratch();

      expect(snapshotTemporaryDirectoryEnvironment()).toEqual({
        TMPDIR: scratch.temporaryBase,
        TEMP: scratch.temporaryBase,
        TMP: scratch.temporaryBase,
      });

      await scratch.dispose();
      scratch = undefined;
      expect(snapshotTemporaryDirectoryEnvironment()).toEqual({ TMPDIR: undefined, TEMP: undefined, TMP: undefined });
    } finally {
      await scratch?.dispose();
      restoreTemporaryDirectoryEnvironment(environmentBeforeTest);
    }
  });

  it('restores temporary-directory variables to their individual prior values', async () => {
    const environmentBeforeTest = snapshotTemporaryDirectoryEnvironment();
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'makaio-ce-fixture-environment-'));
    const previousEnvironment = {
      TMPDIR: join(fixtureRoot, 'tmpdir'),
      TEMP: join(fixtureRoot, 'temp'),
      TMP: join(fixtureRoot, 'tmp'),
    };
    let scratch: CodeExecutionScratch | undefined;

    try {
      for (const value of Object.values(previousEnvironment)) {
        await mkdir(value, { recursive: true });
      }
      restoreTemporaryDirectoryEnvironment(previousEnvironment);
      scratch = await createCodeExecutionScratch();

      expect(snapshotTemporaryDirectoryEnvironment()).toEqual({
        TMPDIR: scratch.temporaryBase,
        TEMP: scratch.temporaryBase,
        TMP: scratch.temporaryBase,
      });

      await scratch.dispose();
      scratch = undefined;
      expect(snapshotTemporaryDirectoryEnvironment()).toEqual(previousEnvironment);
    } finally {
      await scratch?.dispose();
      restoreTemporaryDirectoryEnvironment(environmentBeforeTest);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
