import { describe, expect, it } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import type { RightsCapability } from '@makaio/contracts/rights';
import type { JsonSchema } from '@makaio/contracts/shared';
import { BootProgressObserver } from '../extension/boot-progress-observer.js';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import type { ExtensionContextHost } from '../extension/extension-context-builder.js';
import { startExtensionEntry, type ExtensionStartHost } from '../extension/extension-start-runner.js';
import { OpenContributionIndex } from '../extension/open-contribution-index.js';
import { RuleSourceRegistry } from '../extension/rule-source-registry.js';
import type { ExtensionEntry, KernelMakaioExtension } from '../extension/types.js';
import { ServiceSkipError } from '../service-skip-error.js';
import { createRightsHub } from '../rights/rights-hub.js';
import { TEST_EXTENSION_CONTEXT_BASE } from './extension-context-base-fixture.js';

/** Minimal JSON schema for a right with no question context of its own. */
const EMPTY_CONTEXT_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

const SKIPPED_RIGHT = 'ext.skipped.thing';

describe('rights release on a skipped start (scope extension point 12)', () => {
  it('a skipped start closes the attempt rights record: its capability rejects resolve/staging afterwards', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    let capturedCapability: RightsCapability | undefined;
    let capturedBus: IMakaioBus | undefined;

    const pkg: KernelMakaioExtension = {
      name: 'ext.skipped',
      displayName: 'Skipped',
      version: '0.1.0',
      create: (ctx) => {
        capturedCapability = ctx.rights;
        capturedBus = ctx.bus;
        return {
          init: async () => {
            // Stages a right while `pending`, exactly like a real extension that declares
            // something from data before discovering it should skip.
            ctx.rights.declareRightsFromData([
              { right: SKIPPED_RIGHT, description: 'never committed', context: EMPTY_CONTEXT_SCHEMA },
            ]);
            throw new ServiceSkipError('no configuration provided');
          },
          destroy: () => undefined,
        };
      },
    };

    const entry: ExtensionEntry = {
      pkg,
      identity: createExtensionIdentity(pkg.name),
      state: 'discovered',
      enabled: true,
      extensionManaged: true,
      warnings: [],
    };
    const entries = new Map([[pkg.name, entry]]);
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
    const bootProgress = new BootProgressObserver(bus, 1);
    const host: ExtensionStartHost = {
      bus,
      db: undefined,
      entries,
      contributionProcessors: [],
      contextHost,
      bootProgress,
    };

    try {
      await startExtensionEntry(host, pkg.name, entry);
    } finally {
      bootProgress.dispose();
    }

    // The skip is visible, and nothing it staged ever reached the directory.
    expect(entry.state).toBe('skipped');
    expect(hub.list().some((declared) => declared.right === SKIPPED_RIGHT)).toBe(false);

    const capability = capturedCapability;
    const extensionBus = capturedBus;
    if (capability === undefined || extensionBus === undefined) {
      throw new Error('create() never received a context');
    }

    // The bug this test guards against: without closing the attempt's rights record on the
    // skip path, this capability — bound to the now-abandoned `pending` attempt — would still
    // resolve and could still stage further rights/sources into a record no later attempt or
    // directory entry can ever reach.
    const call = extensionBus.own('start');
    await expect(capability.resolve(call, { right: SKIPPED_RIGHT, context: {} })).rejects.toThrow(/has stopped/);
    expect(() =>
      capability.declareRightsFromData([{ right: SKIPPED_RIGHT, description: 'd', context: EMPTY_CONTEXT_SCHEMA }]),
    ).toThrow(/has stopped/);

    // A re-enable still starts a fresh activation attempt for the same owner.
    expect(() => hub.beginActivation(pkg.name)).not.toThrow();
    expect(() => hub.activate(pkg.name, pkg)).not.toThrow();
  });
});
