import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'bun:test';

import { auditPackage } from './barrel-inventory/audit.js';
import { findExternalConsumers } from './barrel-inventory/cross-check.js';
import { buildInventory } from './barrel-inventory/inventory.js';
import { generateBarrel } from './barrel-inventory/output.js';
import type { ExportEntry } from './barrel-inventory/types.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'barrel-inventory-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('barrel inventory tooling', () => {
  it('preserves source names for aliased explicit re-exports', async () => {
    const root = await makeTempDir();
    await writeJson(path.join(root, 'tsconfig.json'), {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        strict: true,
      },
      include: ['*.ts'],
    });
    await writeFile(
      path.join(root, 'impl.ts'),
      ['export const internalValue = 1;', 'export interface InternalType { value: string; }', ''].join('\n'),
      'utf8',
    );
    const barrelPath = path.join(root, 'index.ts');
    await writeFile(
      barrelPath,
      [
        "export { internalValue as publicValue } from './impl';",
        "export { type InternalType as PublicType } from './impl';",
        '',
      ].join('\n'),
      'utf8',
    );

    const inventory = buildInventory(barrelPath);
    const entries = inventory.groups.get('./impl') as Array<ExportEntry & { sourceName?: string }>;

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'publicValue', sourceName: 'internalValue' }),
        expect.objectContaining({ name: 'PublicType', sourceName: 'InternalType' }),
      ]),
    );
    const generated = generateBarrel(inventory);
    expect(generated).toContain("export { internalValue as publicValue } from './impl';");
    expect(generated).toContain("export type { InternalType as PublicType } from './impl';");
  });

  it('matches concrete imports against wildcard package subpath exports', async () => {
    const root = await makeTempDir();
    const packageDir = path.join(root, 'packages', 'widgets');
    const consumerDir = path.join(root, 'consumer');
    await mkdir(path.join(packageDir, 'src', 'ui'), { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeJson(path.join(root, 'package.json'), { private: true });
    await writeJson(path.join(root, 'tsconfig.json'), {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        strict: true,
        paths: {
          '@test/widgets/ui/*': ['./packages/widgets/src/ui/*'],
        },
      },
      include: ['packages/**/*.ts', 'consumer/**/*.ts'],
    });
    await writeJson(path.join(packageDir, 'package.json'), {
      name: '@test/widgets',
      exports: {
        './ui/*': './src/ui/*',
      },
    });
    await writeFile(path.join(packageDir, 'src', 'ui', 'button.ts'), 'export const Button = 1;\n', 'utf8');
    await writeFile(
      path.join(consumerDir, 'consumer.ts'),
      "import { Button } from '@test/widgets/ui/button';\nconsole.log(Button);\n",
      'utf8',
    );

    const result = await findExternalConsumers(path.join(packageDir, 'src', 'ui', 'button.ts'));

    expect(result.values).toContain('Button');
  });

  it('expands wildcard package exports into concrete audit entry points', async () => {
    const root = await makeTempDir();
    const packageDir = path.join(root, 'packages', 'widgets');
    await mkdir(path.join(packageDir, 'src', 'ui'), { recursive: true });
    await writeJson(path.join(root, 'package.json'), { private: true });
    await writeJson(path.join(root, 'tsconfig.json'), {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        strict: true,
      },
      include: ['packages/**/*.ts'],
    });
    await writeJson(path.join(packageDir, 'package.json'), {
      name: '@test/widgets',
      exports: {
        './ui/*': './src/ui/*',
      },
    });
    await writeFile(path.join(packageDir, 'src', 'ui', 'button.ts'), 'export const Button = 1;\n', 'utf8');

    const result = await auditPackage(packageDir);

    expect(result.entryPoints).toContain('@test/widgets/ui/button');
    expect(result.allSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Button' })]));
  });
});
