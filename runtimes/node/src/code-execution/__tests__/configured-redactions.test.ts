import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectConfiguredRedactions, resolveConfiguredRuntime } from '../configured-redactions.js';
import { REDACTION_PLACEHOLDER, sanitizeDiagnosticMessage } from '../types.js';

describe('collectConfiguredRedactions', () => {
  it('redacts every spelling of a short configured path', async () => {
    const redactions = await collectConfiguredRedactions({
      environment: {},
      packageRoots: new Map([['demo', '/a']]),
      workerPaths: [],
    });

    expect(redactions).toEqual(expect.arrayContaining(['/a', 'file:///a']));
    expect(sanitizeDiagnosticMessage('Could not load /a from file:///a', redactions)).toBe(
      `Could not load ${REDACTION_PLACEHOLDER} from ${REDACTION_PLACEHOLDER}`,
    );
  });

  it('leaves intentionally short environment values out of diagnostics redactions', async () => {
    const redactions = await collectConfiguredRedactions({
      environment: { NODE_ENV: 'dev' },
      packageRoots: new Map(),
      workerPaths: [],
    });

    expect(redactions).not.toContain('dev');
    expect(sanitizeDiagnosticMessage('NODE_ENV=dev', redactions)).toBe('NODE_ENV=dev');
  });

  it('rejects a configured package root that is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'makaio-code-execution-config-'));
    const packageFile = join(root, 'package.js');
    try {
      await writeFile(packageFile, 'export default 1;', 'utf8');

      await expect(
        resolveConfiguredRuntime({
          environment: {},
          packageRoots: new Map([['demo', packageFile]]),
          workerPaths: [],
        }),
      ).rejects.toThrow('A configured package root could not be resolved.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
