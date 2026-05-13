import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExplicitDescriptorDiscovery } from '@makaio/runtime-node';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '../..');

describe('account-manager extension load pipeline', () => {
  // Smoke test for the ExplicitDescriptorDiscovery contract — validates that
  // the descriptor shape accepted by the discovery API round-trips correctly.
  // Real descriptor parsing/validation is covered by runtime-node tests.
  it('descriptor.json is discovered and validated', async () => {
    const discovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'account-manager',
          displayName: 'Makaio Account Manager',
          version: '0.1.0',
          makaio: { framework: '>=0.1.0' },
          entrypoints: {
            browser: 'browser/index',
            server: true as const,
            cli: true as const,
          },
          cli: {
            name: 'account-manager',
            description: 'Manage AI tool credentials',
            hasInteractive: true,
            subcommands: [
              { name: 'list', description: 'List configured accounts' },
              { name: 'switch', description: 'Switch active account' },
              { name: 'label', description: 'Set account label' },
              { name: 'remove', description: 'Remove an account' },
              { name: 'sources', description: 'Show detected credential sources' },
            ],
          },
          execution: 'embedded',
        },
        extensionPath: EXTENSION_ROOT,
        source: 'local',
      },
    ]);

    const discovered = await discovery.discover();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.descriptor.name).toBe('account-manager');
  });

  it('built server entry exports a valid MakaioExtension shape', async () => {
    const mod = await import(pathToFileURL(path.resolve(EXTENSION_ROOT, 'dist/server.mjs')).href);

    expect(mod.default).toBeDefined();
    expect(mod.default.name).toBe('account-manager');
    expect(mod.default.displayName).toBe('Makaio Account Manager');
    expect(typeof mod.default.create).toBe('function');
    expect(mod.default.browser).toEqual({ entrypoint: '/extensions/account-manager/browser/index.js' });
    expect(mod.default.tray).toBeUndefined();
  });

  it('built browser entry exports a valid browser contribution factory', async () => {
    const mod = await import(pathToFileURL(path.resolve(EXTENSION_ROOT, 'dist/browser.mjs')).href);

    expect(typeof mod.default).toBe('function');
    const contribution = mod.default();
    expect(Array.isArray(contribution.widgets)).toBe(true);
    expect(Array.isArray(contribution.pageDefinitions)).toBe(true);
    expect(contribution.pageDefinitions.some((page: { id: string }) => page.id === 'account-manager:analytics')).toBe(
      true,
    );
  });

  it('built cli entry exports a valid CliContribution shape', async () => {
    const mod = await import(pathToFileURL(path.resolve(EXTENSION_ROOT, 'dist/cli.mjs')).href);

    expect(mod.default).toBeDefined();
    expect(mod.default.name).toBe('account-manager');
    expect(Array.isArray(mod.default.subcommands)).toBe(true);
  });

  // bus-core is externalized by extensionExternals, so if @makaio/contracts
  // (which is inlined) has runtime bus-core imports, they appear as external
  // import statements in the output. This test verifies the account-manager
  // extension itself has no runtime bus-core dependency — contracts' bus
  // registrations are tree-shaken because the extension only uses type imports
  // from contracts. If this test fails after a build, it means a runtime
  // bus-core import leaked into the extension bundle.
  it('built bundle does not keep a runtime @makaio/bus-core import', async () => {
    const serverBundle = await fs.readFile(path.resolve(EXTENSION_ROOT, 'dist/server.mjs'), 'utf8');

    expect(serverBundle).not.toContain("'@makaio/bus-core'");
    expect(serverBundle).not.toContain('"@makaio/bus-core"');
  });
});
