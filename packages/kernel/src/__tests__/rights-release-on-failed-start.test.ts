import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { RightContribution } from '@makaio/contracts/rights';
import type { JsonSchema } from '@makaio/contracts/shared';
import { BootProgressObserver, type BootProgressPackage } from '../extension/boot-progress-observer.js';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import type { ExtensionContextHost } from '../extension/extension-context-builder.js';
import { startExtensionEntry, type ExtensionStartHost } from '../extension/extension-start-runner.js';
import { OpenContributionIndex } from '../extension/open-contribution-index.js';
import { RuleSourceRegistry } from '../extension/rule-source-registry.js';
import type { ExtensionEntry, KernelMakaioExtension } from '../extension/types.js';
import { createRightsHub } from '../rights/rights-hub.js';
import { TEST_EXTENSION_CONTEXT_BASE } from './extension-context-base-fixture.js';

/** Minimal JSON schema for a right with no question context of its own. */
const EMPTY_CONTEXT_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

/** The one right the test package declares. */
const RIGHT: RightContribution = {
  right: 'ext.owner.read',
  description: 'test right',
  context: EMPTY_CONTEXT_SCHEMA,
};

/** Extension whose `create` succeeds; failure is injected via boot progress instead. */
const PKG: KernelMakaioExtension = {
  name: 'ext.owner',
  displayName: 'Owner',
  version: '0.1.0',
  rights: [RIGHT],
  create: () => ({ init: () => Promise.resolve(), destroy: () => undefined }),
};

/** {@link BootProgressObserver} whose `ready()` throws, simulating a failure after the entry's rights already committed. */
class ThrowingReadyBootProgressObserver extends BootProgressObserver {
  public override ready(pkg: BootProgressPackage): void {
    throw new Error(`boot progress ready failed for "${pkg.name}"`);
  }
}

describe('rights release after a start fails past the rights commit (point 5)', () => {
  it('a start whose ready throws leaves the right unknown/unsourced and a re-enable succeeds and activates the rights again', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const entry: ExtensionEntry = {
      pkg: PKG,
      identity: createExtensionIdentity(PKG.name),
      state: 'discovered',
      enabled: true,
      extensionManaged: true,
      warnings: [],
    };
    const entries = new Map([[PKG.name, entry]]);
    const openContributionIndex = new OpenContributionIndex();
    const contextHost: ExtensionContextHost = {
      bus,
      extensionContextBase: TEST_EXTENSION_CONTEXT_BASE,
      loadConfig: undefined,
      operatorConfig: undefined,
      signal: new AbortController().signal,
      hasActiveExtension: () => false,
      openContributionReaderFor: (name) => openContributionIndex.readerFor(name),
      rights: hub,
      rules: new RuleSourceRegistry(),
      getExtensionService: () => undefined,
    };
    const bootProgress = new ThrowingReadyBootProgressObserver(bus, 1);
    const host: ExtensionStartHost = {
      bus,
      db: undefined,
      entries,
      contributionProcessors: [],
      contextHost,
      bootProgress,
    };

    try {
      await startExtensionEntry(host, PKG.name, entry);
    } finally {
      bootProgress.dispose();
    }

    // The failed attempt is visible as `failed`...
    expect(entry.state).toBe('failed');
    // ...and nothing it committed is: the right it declared is gone.
    expect(hub.list().some((declared) => declared.right === RIGHT.right)).toBe(false);

    // A re-enable starts a fresh activation attempt for the same owner and must
    // not hit "already active" — the bug this test guards against.
    expect(() => hub.beginActivation(PKG.name)).not.toThrow();
    expect(() => hub.activate(PKG.name, PKG)).not.toThrow();
    expect(hub.list().some((declared) => declared.right === RIGHT.right)).toBe(true);
  });
});
