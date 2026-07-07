import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a TypeScript fixture file inside a test workspace.
 * @param workspace - Absolute workspace root.
 * @param fileName - Fixture file name.
 * @param lines - File content lines.
 * @returns Absolute fixture path.
 */
export function writeFixture(workspace: string, fileName: string, lines: string[]): string {
  const filePath = path.join(workspace, fileName);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

/**
 * Write a strict TypeScript workspace tsconfig for fixture tests.
 * @param workspace - Absolute workspace root.
 * @returns Absolute tsconfig path.
 */
export function writeWorkspaceTsConfig(workspace: string): string {
  const tsconfigPath = path.join(workspace, 'tsconfig.json');
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'Bundler',
      },
      include: ['*.ts'],
    }),
  );
  return tsconfigPath;
}
