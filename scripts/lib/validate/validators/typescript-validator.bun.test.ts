import { mkdtemp, mkdir, writeFile, chmod, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'bun:test';
import { ValidatorContext } from '../util/validator-context.js';
import type { FileValidationResults } from '../types.js';
import { findTsgoBinary, validateTypeScriptWithConfig } from './typescript-validator.js';

const originalCwd = process.cwd();
const tempRoots: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makaio-ts-validator-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  process.chdir(originalCwd);
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('findTsgoBinary', () => {
  it('finds the Windows command shim when no bare tsgo file exists', async () => {
    const root = await createTempWorkspace();
    const binDir = path.join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const shimPath = path.join(binDir, 'tsgo.cmd');
    await writeFile(shimPath, '');

    expect(findTsgoBinary(root, 'win32')).toBe(shimPath);
  });
});

describe('validateTypeScriptWithConfig', () => {
  it('reports only files included by the selected tsconfig as checked when tsgo is available', async () => {
    const root = await createTempWorkspace();
    process.chdir(root);

    const binDir = path.join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const tsgoPath = path.join(binDir, 'tsgo');
    const includedFile = path.join(root, 'included.ts');
    const excludedFile = path.join(root, 'excluded.ts');
    await writeFile(
      tsgoPath,
      `#!/bin/sh\necho "${includedFile}(1,14): error TS2322: synthetic tsgo diagnostic"\nexit 0\n`,
    );
    await chmod(tsgoPath, 0o755);

    await writeFile(includedFile, 'export const included = true;\n');
    await writeFile(excludedFile, 'export const excluded = true;\n');
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        files: ['included.ts'],
      }),
    );

    const results: FileValidationResults = {};
    const ctx = new ValidatorContext(results);
    const output = await validateTypeScriptWithConfig(
      [includedFile, excludedFile],
      path.join(root, 'tsconfig.json'),
      ctx,
    );

    expect(output.filesChecked).toEqual([includedFile]);
    expect(results[includedFile]).toEqual([
      expect.objectContaining({
        message: 'synthetic tsgo diagnostic',
        ruleId: 'TS2322',
        tool: 'typescript',
      }),
    ]);
    expect(results[excludedFile]).toBeUndefined();
  });

  it('falls back to TypeScript diagnostics when the tsgo subprocess fails', async () => {
    const root = await createTempWorkspace();
    process.chdir(root);

    const binDir = path.join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const tsgoPath = path.join(binDir, 'tsgo');
    await writeFile(tsgoPath, '#!/bin/sh\nexit 1\n');
    await chmod(tsgoPath, 0o755);

    const includedFile = path.join(root, 'included.ts');
    await writeFile(includedFile, 'const value: string = 1;\n');
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        files: ['included.ts'],
      }),
    );

    const results: FileValidationResults = {};
    const ctx = new ValidatorContext(results);
    const output = await validateTypeScriptWithConfig([includedFile], path.join(root, 'tsconfig.json'), ctx);

    expect(output.filesChecked).toEqual([includedFile]);
    expect(results[includedFile]).toContainEqual(
      expect.objectContaining({
        ruleId: 'TS2322',
        tool: 'typescript',
      }),
    );
  });
});
