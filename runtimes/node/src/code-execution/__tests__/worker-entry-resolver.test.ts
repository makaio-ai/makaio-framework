import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCodeExecutionWorkerEntry, resolveDefaultCodeExecutionWorkerEntry } from '../worker-entry-resolver.js';

describe('resolveCodeExecutionWorkerEntry', () => {
  it('resolves the TypeScript entry with a TypeScript entry loader in source mode', () => {
    const entry = resolveCodeExecutionWorkerEntry({ moduleDir: '/pkg/src', mode: 'source' });

    expect(entry.filename).toBe(join('/pkg/src', 'code-execution', 'worker-entry.ts'));
    expect(entry.execArgv).toEqual(['--import=tsx']);
    // The loader is pinned to a tsconfig this package ships, so it applies no
    // ambient `paths` alias — without which a submitted bare specifier could be
    // expanded to a path before the import allowlist ever saw a package name.
    expect(entry.env).toEqual({
      TSX_TSCONFIG_PATH: join('/pkg/src', 'code-execution', 'worker-tsconfig.json'),
    });
  });

  it('resolves the built entry without a TypeScript entry loader in dist mode', () => {
    const entry = resolveCodeExecutionWorkerEntry({ moduleDir: '/pkg/dist', mode: 'dist' });

    expect(entry.filename).toBe(join('/pkg/dist', 'code-execution', 'worker-entry.mjs'));
    expect(entry.execArgv).toEqual([]);
    // Nothing to configure: the built entry loads no loader at all.
    expect(entry.env).toEqual({});
  });

  it('appends the worker directory to a nested distribution root without duplicating a segment', () => {
    const entry = resolveCodeExecutionWorkerEntry({ moduleDir: '/pkg/dist/runtime-node', mode: 'dist' });

    expect(entry.filename).toBe(join('/pkg/dist/runtime-node', 'code-execution', 'worker-entry.mjs'));
  });
});

describe('resolveDefaultCodeExecutionWorkerEntry', () => {
  it('resolves the source entry for a module inside the source worker directory', () => {
    const moduleUrl = pathToFileURL('/pkg/src/code-execution/piscina-code-execution-provider.ts').href;

    const entry = resolveDefaultCodeExecutionWorkerEntry(moduleUrl);

    expect(entry.filename).toBe(join('/pkg/src', 'code-execution', 'worker-entry.ts'));
    expect(entry.execArgv).toEqual(['--import=tsx']);
  });

  it('resolves the built entry for a module bundled into the worker distribution directory', () => {
    const moduleUrl = pathToFileURL('/pkg/dist/code-execution/index.mjs').href;

    const entry = resolveDefaultCodeExecutionWorkerEntry(moduleUrl);

    expect(entry.filename).toBe(join('/pkg/dist', 'code-execution', 'worker-entry.mjs'));
    expect(entry.execArgv).toEqual([]);
  });

  it('resolves the built entry for a module bundled into the distribution root barrel', () => {
    const moduleUrl = pathToFileURL('/pkg/dist/index.mjs').href;

    const entry = resolveDefaultCodeExecutionWorkerEntry(moduleUrl);

    expect(entry.filename).toBe(join('/pkg/dist', 'code-execution', 'worker-entry.mjs'));
  });

  it('resolves the built entry for a nested distribution root barrel', () => {
    const moduleUrl = pathToFileURL('/pkg/dist/runtime-node/index.mjs').href;

    const entry = resolveDefaultCodeExecutionWorkerEntry(moduleUrl);

    expect(entry.filename).toBe(join('/pkg/dist/runtime-node', 'code-execution', 'worker-entry.mjs'));
  });

  it('resolves an entry that exists on disk for the running source layout', async () => {
    const providerUrl = pathToFileURL(join(import.meta.dirname, '..', 'piscina-code-execution-provider.ts')).href;

    const entry = resolveDefaultCodeExecutionWorkerEntry(providerUrl);

    expect(entry.execArgv).toEqual(['--import=tsx']);
    await expect(stat(entry.filename)).resolves.toMatchObject({});
    // The loader refuses to start when the tsconfig it is pointed at is absent,
    // so this file has to ship with the source layout rather than be assumed.
    for (const path of Object.values(entry.env)) {
      await expect(stat(path)).resolves.toMatchObject({});
    }
  });
});
