import { describe, expect, it } from 'bun:test';
import { mapFilesToPackages } from './map-files-to-packages.js';

describe('mapFilesToPackages', () => {
  it('maps packages/contracts/ to @makaio/contracts', () => {
    expect(mapFilesToPackages(['packages/contracts/src/index.ts'])).toEqual(['@makaio/contracts']);
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
    expect(
      mapFilesToPackages(['extensions/reviewer-coderabbit/src/index.ts', 'providers/qwen/src/package.ts']),
    ).toEqual(['@makaio/provider-qwen-acp', '@makaio/reviewer-coderabbit']);
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
        'packages/contracts/src/types.ts',
        'adapters/implementations/openai-node/src/connector.ts',
      ]),
    ).toEqual(['@makaio/adapter-openai-node', '@makaio/contracts', '@makaio/framework']);
  });

  it('returns empty array for non-publishable files', () => {
    expect(mapFilesToPackages(['docs/README.md', '.github/workflows/ci.yml'])).toEqual([]);
  });

  it('deduplicates when two files belong to the same package', () => {
    expect(mapFilesToPackages(['packages/contracts/src/index.ts', 'packages/contracts/src/types.ts'])).toEqual([
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
    expect(
      mapFilesToPackages(['clients/...', 'extensions/...', 'adapters/implementations/__tests__/shared.ts']),
    ).toEqual(['@makaio/framework']);
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
