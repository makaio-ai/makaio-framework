import path from 'path';
import { describe, expect, it } from 'vitest';
import { getWorkerKillTarget, getWorkerCommand } from './spawner.js';

describe('getWorkerKillTarget', () => {
  it('targets the process group on POSIX so wrapper descendants are terminated', () => {
    expect(getWorkerKillTarget(123, 'linux')).toBe(-123);
    expect(getWorkerKillTarget(123, 'darwin')).toBe(-123);
  });

  it('targets the child process on Windows where negative process groups are unsupported', () => {
    expect(getWorkerKillTarget(123, 'win32')).toBe(123);
  });
});

describe('getWorkerCommand', () => {
  const expectedTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

  it('uses bun for most tools', () => {
    expect(getWorkerCommand('biome', '/w/biome.ts')).toEqual(['bun', ['/w/biome.ts']]);
    expect(getWorkerCommand('typescript', '/w/typescript.ts')).toEqual(['bun', ['/w/typescript.ts']]);
    expect(getWorkerCommand('prettier', '/w/prettier.ts')).toEqual(['bun', ['/w/prettier.ts']]);
    expect(getWorkerCommand('stylelint', '/w/stylelint.ts')).toEqual(['bun', ['/w/stylelint.ts']]);
  });

  it('uses local tsx for eslint due to CJS plugin resolution performance', () => {
    expect(getWorkerCommand('eslint', '/w/eslint.ts')).toEqual([expectedTsx, ['/w/eslint.ts']]);
  });
});
