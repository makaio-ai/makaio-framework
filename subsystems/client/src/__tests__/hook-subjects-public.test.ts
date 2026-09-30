/**
 * Boundary tests for the `@makaio/subsystem-client/hook-subjects` subpath.
 *
 * CLI hook subprocesses import this entrypoint on every client hook event, so
 * it must build the raw hook subjects without evaluating the client subsystem
 * index, its services, or its storage layer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeImports,
  hasDynamicImportCall,
  readManifest,
} from '@makaio/build-tooling/source-runtime-imports';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const frameworkRoot = dirname(dirname(packageRoot));
const frameworkPackageRoot = join(frameworkRoot, 'packages', 'framework');
const hookSubjectsSourcePath = join(packageRoot, 'src', 'hook-subjects.ts');

/**
 * The only module the hook-subjects entrypoint may load at runtime. Every
 * other dependency must be a type-only import, which the compiler erases.
 */
const ALLOWED_RUNTIME_IMPORTS = ['zod'] as const;

describe('@makaio/subsystem-client/hook-subjects subpath', () => {
  it('loads no runtime module other than zod', () => {
    const source = readFileSync(hookSubjectsSourcePath, 'utf8');

    expect(collectRuntimeImports(source, hookSubjectsSourcePath)).toEqual([...ALLOWED_RUNTIME_IMPORTS]);
    expect(hasDynamicImportCall(source, hookSubjectsSourcePath)).toBe(false);
  });

  it('builds the raw hook subjects', async () => {
    const mod = await import('@makaio/subsystem-client/hook-subjects');

    expect(mod.createRawClientHookReceivedSubject(' Client:Claude-Code ')).toEqual({
      subject: 'hook.received',
      $meta: { namespace: 'client:claude-code', isRequest: false, local: false, channel: false },
    });
    expect(mod.createRawClientHookHandleSubject('client:codex')).toEqual({
      subject: 'hook.handle',
      $meta: { namespace: 'client:codex', isRequest: true, local: false, channel: false, hostLocalRequest: true },
    });
    expect(mod.ClientHookHandleResponseSchema.parse({})).toEqual(mod.NOOP_HOOK_HANDLE_RESPONSE);
    expect('ClientSubjects' in mod).toBe(false);
  }, 15_000);

  it('exposes the subpath in the workspace, publish, and umbrella export maps', () => {
    const clientManifest = readManifest(join(packageRoot, 'package.json'));

    expect(clientManifest.exports).toMatchObject({
      './hook-subjects': './src/hook-subjects.ts',
    });
    expect((clientManifest.publishConfig as { exports?: unknown } | undefined)?.exports).toMatchObject({
      './hook-subjects': './dist/hook-subjects.mjs',
    });
    expect(readManifest(join(frameworkPackageRoot, 'package.json')).exports).toMatchObject({
      './clients/hook-subjects': {
        types: './dist/clients/hook-subjects.d.mts',
        default: './dist/clients/hook-subjects.mjs',
      },
    });
  });
});
