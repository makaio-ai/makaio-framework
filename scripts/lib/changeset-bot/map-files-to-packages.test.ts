import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapFilesToPackages } from './map-files-to-packages.js';

describe('mapFilesToPackages', () => {
  it('maps core/contracts/ to @makaio/contracts', () => {
    expect(mapFilesToPackages(['core/contracts/src/index.ts'])).toEqual(['@makaio/contracts']);
  });

  it('maps packages/kernel/ to @makaio/framework', () => {
    expect(mapFilesToPackages(['packages/kernel/src/index.ts'])).toEqual(['@makaio/framework']);
  });

  it('maps adapter implementations to @makaio/adapter-<name>', () => {
    expect(mapFilesToPackages(['adapters/implementations/anthropic-sdk/src/agent.ts'])).toEqual([
      '@makaio/adapter-anthropic-sdk',
    ]);
  });

  it('maps clients to @makaio/client-<name>', () => {
    expect(mapFilesToPackages(['clients/claude-code/src/index.ts'])).toEqual(['@makaio/client-claude-code']);
  });

  it('maps providers to @makaio/provider-<name>', () => {
    expect(mapFilesToPackages(['providers/openai/src/definition.ts'])).toEqual(['@makaio/provider-openai']);
  });

  it('uses real package names when directory conventions differ from package.json names', () => {
    expect(mapFilesToPackages(['extensions/coderabbit/src/index.ts', 'providers/qwen/src/package.ts'])).toEqual([
      '@makaio/extension-coderabbit',
      '@makaio/provider-qwen-acp',
    ]);
  });

  it('maps extensions to @makaio/extension-<name>', () => {
    expect(mapFilesToPackages(['extensions/prompt/src/index.ts'])).toEqual(['@makaio/extension-prompt']);
  });

  it('maps sdks/typescript/ to @makaio/sdk', () => {
    expect(mapFilesToPackages(['sdks/typescript/src/index.ts'])).toEqual(['@makaio/sdk']);
  });

  it('returns multiple packages sorted when files span framework, contracts, and adapter', () => {
    expect(
      mapFilesToPackages([
        'packages/kernel/src/index.ts',
        'core/contracts/src/types.ts',
        'adapters/implementations/openai-node/src/connector.ts',
      ]),
    ).toEqual(['@makaio/adapter-openai-node', '@makaio/contracts', '@makaio/framework']);
  });

  it('returns empty array for non-publishable files', () => {
    expect(mapFilesToPackages(['docs/README.md', '.github/workflows/ci.yml', 'scripts/changeset-required.ts'])).toEqual(
      [],
    );
  });

  it('returns empty array for dependency lockfile-only changes', () => {
    expect(mapFilesToPackages(['yarn.lock', 'scripts/bun.lock'])).toEqual([]);
  });

  it('ignores lockfiles while preserving publishable package changes', () => {
    expect(mapFilesToPackages(['yarn.lock', 'core/contracts/src/index.ts'])).toEqual(['@makaio/contracts']);
  });

  it('returns empty array for tests-only changes in publishable packages', () => {
    expect(
      mapFilesToPackages([
        'core/contracts/src/index.test.ts',
        'clients/claude-code/src/__tests__/schemas.test.ts',
        'providers/openai/src/fixtures/model-response.json',
        'extensions/prompt/src/snapshots/render.json',
        'packages/kernel/src/namespace.spec.mts',
      ]),
    ).toEqual([]);
  });

  it('ignores tests while preserving publishable source changes', () => {
    expect(mapFilesToPackages(['core/contracts/src/index.test.ts', 'core/contracts/src/index.ts'])).toEqual([
      '@makaio/contracts',
    ]);
  });

  it('does not treat a package name segment "test" as non-publishable', () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'makaio-changeset-map-'));
    try {
      const packageRoot = join(frameworkRoot, 'clients/test');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@makaio/client-test' }));

      expect(mapFilesToPackages(['clients/test/src/index.ts'], { frameworkRoot })).toEqual(['@makaio/client-test']);
    } finally {
      rmSync(frameworkRoot, { force: true, recursive: true });
    }
  });

  it('deduplicates when two files belong to the same package', () => {
    expect(mapFilesToPackages(['core/contracts/src/index.ts', 'core/contracts/src/types.ts'])).toEqual([
      '@makaio/contracts',
    ]);
  });

  it('maps root config files to @makaio/framework', () => {
    expect(mapFilesToPackages(['tsconfig.json', 'package.json'])).toEqual(['@makaio/framework']);
  });

  it('maps adapters/core/ to @makaio/framework', () => {
    expect(mapFilesToPackages(['adapters/core/src/adapter.ts'])).toEqual(['@makaio/framework']);
  });

  it('does not turn CodeRabbit display placeholders into package names', () => {
    expect(mapFilesToPackages(['clients/...', 'extensions/...'])).toEqual([]);
  });

  it('maps adapters/shared/ to @makaio/framework', () => {
    expect(mapFilesToPackages(['adapters/shared/stream-session/src/index.ts'])).toEqual(['@makaio/framework']);
  });

  it('maps apps/ to @makaio/framework', () => {
    expect(mapFilesToPackages(['apps/electrobun/src/main.ts'])).toEqual(['@makaio/framework']);
  });

  it('returns empty array for an empty input', () => {
    expect(mapFilesToPackages([])).toEqual([]);
  });
});
