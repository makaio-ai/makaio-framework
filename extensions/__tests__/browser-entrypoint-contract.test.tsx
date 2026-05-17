// @vitest-environment node

/**
 * Browser entrypoint contract test.
 *
 * Validates that every extension browser entrypoint can be imported without
 * pulling in Node.js built-in modules. In the real renderer, Vite
 * externalizes `node:*` for browser compatibility — any access at module
 * evaluation time crashes the extension loader. This test catches those
 * leaks at `yarn test` time by replacing `node:*` modules with traps.
 *
 * Runs in a Node.js Vitest environment so descriptor discovery can use the same
 * synchronous filesystem/esbuild path as the Vite app configs.
 * @see docs/architecture/extensions/browser.md — "Import guidance"
 * @see docs/creating-extensions.md — "Browser Entrypoint"
 */

import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  buildRuntimeBrowserDevEntryForDescriptorRoot,
  discoverDescriptorRootsFromConfig,
} from '../../scripts/lib/discover-extension-browser-dev-entries.js';
import type { ExtensionDevEntry } from '../../scripts/lib/vite-extension-dev-plugin.js';

// ---------------------------------------------------------------------------
// Trap factory — must be declared before vi.mock calls because vi.mock
// hoists the factory but keeps references to module-scope identifiers.
// ---------------------------------------------------------------------------

function trap(mod: string): () => Record<string, unknown> {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'default') {
        throw new Error(
          `[browser-contract] Browser entrypoint imported "${mod}" via default import — ` +
            `node:* modules are not available in the browser. ` +
            `See docs/architecture/extensions/browser.md for import guidance.`,
        );
      }
      throw new Error(
        `[browser-contract] Browser entrypoint transitively imported "${mod}.${String(prop)}" — ` +
          `node:* modules are not available in the browser. ` +
          `See docs/architecture/extensions/browser.md for import guidance.`,
      );
    },
  };
  const proxy = new Proxy({} as Record<string, unknown>, handler);
  return () => proxy;
}

/**
 * Install traps after descriptor discovery has loaded its Node.js helpers.
 *
 * `vi.mock` is hoisted and would replace `node:fs`/`node:path` before
 * `discoverExtensionBrowserRuntimeDevEntries()` can read descriptors. `vi.doMock`
 * is intentionally non-hoisted, so the app's canonical browser-entry discovery
 * can run first while browser entries imported later still see trapped built-ins.
 */
function installNodeBuiltinTraps(): void {
  vi.doMock('node:crypto', trap('node:crypto'));
  vi.doMock('node:fs', trap('node:fs'));
  vi.doMock('node:fs/promises', trap('node:fs/promises'));
  vi.doMock('node:path', trap('node:path'));
  vi.doMock('node:os', trap('node:os'));
  vi.doMock('node:url', trap('node:url'));
  vi.doMock('node:child_process', trap('node:child_process'));
  vi.doMock('node:util', trap('node:util'));
  vi.doMock('node:stream', trap('node:stream'));
  vi.doMock('node:net', trap('node:net'));
  vi.doMock('node:http', trap('node:http'));
  vi.doMock('node:https', trap('node:https'));
  vi.doMock('node:buffer', trap('node:buffer'));
  vi.doMock('node:events', trap('node:events'));
  vi.doMock('node:worker_threads', trap('node:worker_threads'));
  vi.doMock('node:process', trap('node:process'));
  vi.doMock('crypto', trap('crypto'));
  vi.doMock('fs', trap('fs'));
  vi.doMock('fs/promises', trap('fs/promises'));
  vi.doMock('path', trap('path'));
  vi.doMock('os', trap('os'));
  vi.doMock('child_process', trap('child_process'));
}

function browserEntryName(urlPath: string): string {
  const match = /^\/extensions\/([^/]+)\/browser\//.exec(urlPath);
  if (!match?.[1]) {
    throw new Error(`[browser-contract] Invalid discovered browser entry URL: ${urlPath}`);
  }
  return match[1];
}

const FRAMEWORK_ROOT = resolve(import.meta.dirname, '../..');
const EXTENSION_DESCRIPTOR_DISCOVERY_PATHS = [
  'adapters/implementations',
  'clients',
  'extensions',
  'providers',
] as const;

function discoverContractBrowserEntries(): ExtensionDevEntry[] {
  return discoverDescriptorRootsFromConfig(FRAMEWORK_ROOT, EXTENSION_DESCRIPTOR_DISCOVERY_PATHS).flatMap(
    (descriptorRoot) => buildRuntimeBrowserDevEntryForDescriptorRoot(descriptorRoot) ?? [],
  );
}

const BROWSER_ENTRIES = discoverContractBrowserEntries().map((entry) => ({
  name: browserEntryName(entry.urlPath),
  sourceAbsPath: entry.sourceAbsPath,
}));

if (BROWSER_ENTRIES.length === 0) {
  throw new Error('[browser-contract] No browser entries discovered from the configured extension descriptor roots.');
}

installNodeBuiltinTraps();

const BROWSER_ENTRY_IMPORT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser entrypoint contract — no node:* built-in imports', () => {
  it('rejects default-imported node built-ins', () => {
    expect(() => trap('node:path')().default).toThrow(
      '[browser-contract] Browser entrypoint imported "node:path" via default import',
    );
  });

  for (const entry of BROWSER_ENTRIES) {
    it(`${entry.name}: browser entry imports no node:* built-ins`, async () => {
      const mod = await import(entry.sourceAbsPath);
      expect(mod).toBeDefined();
    }, BROWSER_ENTRY_IMPORT_TIMEOUT_MS);
  }
});
