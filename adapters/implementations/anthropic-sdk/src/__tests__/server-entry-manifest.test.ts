import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for the P1c finding: the published
 * `@makaio/adapter-anthropic-sdk` package had no loadable server entry, so
 * extension discovery could not load the adapter and it had to be registered
 * manually via `createAnthropicSdkAdapter`.
 *
 * Extension discovery resolves the descriptor's `entrypoints.server: true`
 * via the runtime convention (`resolveConventionEntrypoint` in
 * `@makaio/runtime-node`): `src/server.ts` in dev, `dist/server.mjs` in the
 * published artifact. Since the published package ships only `dist/`
 * (`files: ["dist", ...]`), the build must emit `dist/server.mjs` and the
 * manifest must export it — same pattern as `@makaio/provider-anthropic`.
 */

interface ConditionalExport {
  readonly types?: string;
  readonly default?: string;
}

interface AdapterManifest {
  readonly exports?: Readonly<Record<string, ConditionalExport | string>>;
  readonly publishConfig?: {
    readonly exports?: Readonly<Record<string, ConditionalExport | string>>;
  };
}

interface AdapterDescriptor {
  readonly name?: string;
  readonly entrypoints?: { readonly server?: true | string };
}

function readPackageJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')) as unknown;
}

const manifest = readPackageJson('../../package.json') as AdapterManifest;
const descriptor = readPackageJson('../../descriptor.json') as AdapterDescriptor;

describe('server entry packaging (descriptor convention)', () => {
  it('descriptor declares the convention server entrypoint', () => {
    expect(descriptor.entrypoints?.server).toBe(true);
  });

  it('workspace exports map declares ./server pointing at dist/server.mjs', () => {
    const serverExport = manifest.exports?.['./server'];
    expect(serverExport).toBeDefined();
    expect(typeof serverExport === 'string' ? serverExport : serverExport?.default).toBe('./dist/server.mjs');
  });

  it('publishConfig exports map declares ./server pointing at dist/server.mjs', () => {
    const serverExport = manifest.publishConfig?.exports?.['./server'];
    expect(serverExport).toBeDefined();
    expect(typeof serverExport === 'string' ? serverExport : serverExport?.default).toBe('./dist/server.mjs');
  });

  it('build config emits the server entry so dist/server.mjs exists in the published artifact', () => {
    const buildConfig = readFileSync(fileURLToPath(new URL('../../build.ts', import.meta.url)), 'utf8');
    expect(buildConfig).toContain("server: './src/server.ts'");
  });

  // The dynamic import pulls in the full adapter graph, which can exceed the
  // 5s per-test default on constrained CI runners.
  it('server entry default export matches the descriptor name (loader identity gate)', async () => {
    const serverModule = (await import('../server.js')) as { default?: { name?: string } };
    expect(serverModule.default?.name).toBe(descriptor.name);
  }, 30_000);
});
