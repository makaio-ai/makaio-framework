import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateSchema } from '../generate-schema.js';
import { createTestWorkspace } from './shared.js';

let tempDir: string | null = null;

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('generateSchema', () => {
  it('writes a deterministic .generated/schema.ts for a temp workspace', async () => {
    tempDir = await createTestWorkspace();

    const servicesRoot = path.join(tempDir, 'services', 'alpha');
    const libsRoot = path.join(tempDir, 'libs', 'beta');
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await generateSchema({ workspaceRoot: tempDir, generatedDir, logger });

    const schemaPath = path.join(generatedDir, 'schema.ts');
    const schemaContents = await readFile(schemaPath, 'utf-8');

    const expected = [
      `export * from '${toPosix(path.resolve(libsRoot, 'src', 'extra.ts'))}';`,
      `export * from '${toPosix(path.resolve(libsRoot, 'src', 'schema.ts'))}';`,
      `export * from '${toPosix(path.resolve(servicesRoot, 'src', 'storage', 'schema.ts'))}';`,
      '',
    ].join('\n');

    expect(schemaContents).toBe(expected);
  });
});
