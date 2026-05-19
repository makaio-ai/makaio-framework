/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { ExtensionWarningSchema } from '@makaio/contracts';
import { AccountManager } from '../account-manager.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Minimal extension of {@link InMemoryCredentialSource} that adds a
 * controllable {@link getConfigIssue} implementation for health-check tests.
 *
 * Keeping this in the test file avoids adding test-only state to shared
 * infrastructure while still exercising the real source-health code path.
 */
class ConfigurableCredentialSource extends InMemoryCredentialSource {
  private configIssue: { reason: string; action: string } | null | 'throw' = null;

  /**
   * Set the value that {@link getConfigIssue} will resolve to, or `'throw'`
   * to make the probe throw an error.
   * @param value - The issue to return, null for no issue, or 'throw'
   */
  setConfigIssue(value: { reason: string; action: string } | null | 'throw'): void {
    this.configIssue = value;
  }

  async getConfigIssue(): Promise<{ reason: string; action: string } | null> {
    if (this.configIssue === 'throw') {
      throw new Error('config probe failed');
    }
    return this.configIssue;
  }
}

function createHealthTestService(source: InMemoryCredentialSource, options: { makaioCommand?: string } = {}) {
  const bus = createBusInstance();
  const store = new InMemoryAccountStore();
  const service = new AccountManager(bus, {
    sources: [source],
    credentialStore: store.credentialStore,
    metadataStore: store.metadataStore,
    usageSnapshotStore: store.usageSnapshotStore,
    pollIntervalMs: 60_000,
    makaioCommand: options.makaioCommand ?? 'makaio-test',
  });

  return { bus, service };
}

/**
 * Register a wiring handler that reports all entries as installed for the given
 * client. Returns an unsubscribe function.
 * @param bus - Bus instance to register the handler on
 * @param clientId - Client for which all wiring entries are installed
 */
function registerFullyWiredHandler(bus: ReturnType<typeof createBusInstance>, clientId: string): () => void {
  return bus.on(ClientSubjects.wiring.list, (ctx) => {
    ctx.setResult({
      results: [
        {
          clientId,
          entries: [
            {
              group: 'session-events',
              name: 'SessionStart',
              installed: true,
              command: `makaio hook received ${clientId} SessionStart`,
            },
          ],
        },
      ],
    });
  });
}

describe('AccountManager checkHealth', () => {
  it('reports a recommended integration warning when client wiring entries are missing', async () => {
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const { bus, service } = createHealthTestService(source);
    const cleanup = bus.on(ClientSubjects.wiring.list, (ctx) => {
      expect(ctx.payload.clientId).toBe('claude-code');
      expect(ctx.payload.makaioCommand).toBe('makaio-test');
      ctx.setResult({
        results: [
          {
            clientId: 'claude-code',
            entries: [
              {
                group: 'session-events',
                name: 'SessionStart',
                installed: true,
                command: 'makaio hook received claude-code SessionStart',
              },
              {
                group: 'usage-stream',
                name: 'statusline',
                installed: false,
                command: 'makaio claude statusline',
              },
            ],
          },
        ],
      });
    });

    try {
      await service.init();

      const warnings = await service.checkHealth();

      expect(warnings).toContainEqual({
        severity: 'recommended',
        title: 'Claude Code integration wiring incomplete',
        message: 'Claude Code has 1 integration entry that is not installed.',
        action: { kind: 'configure-integration', clientId: 'claude-code', bundle: 'account-manager' },
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('reports availability probe failures separately from missing installations', async () => {
    const source = new InMemoryCredentialSource('codex', 'Codex');
    source.isAvailable = async () => {
      throw new Error('native credential store locked');
    };
    const { service } = createHealthTestService(source);

    try {
      await service.init();

      const warnings = await service.checkHealth();

      expect(warnings).toEqual([
        {
          severity: 'degraded',
          title: 'Codex health check unavailable',
          message: 'Could not inspect whether Codex is installed: native credential store locked',
        },
      ]);
    } finally {
      await service.destroy();
    }
  });

  it('rejects blank host-provided launcher commands for wiring health checks', async () => {
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const { service } = createHealthTestService(source, { makaioCommand: '   ' });

    try {
      await service.init();

      await expect(service.checkHealth()).rejects.toThrow(
        'AccountManager.checkHealth requires a host-provided launcher command.',
      );
    } finally {
      await service.destroy();
    }
  });

  it('returns an empty array when all sources are available, have no config issues, and wiring is complete', async () => {
    const source = new ConfigurableCredentialSource('claude-code', 'Claude Code');
    source.setConfigIssue(null);
    const { bus, service } = createHealthTestService(source);
    const cleanup = registerFullyWiredHandler(bus, 'claude-code');

    try {
      await service.init();

      const warnings = await service.checkHealth();

      expect(warnings).toEqual([]);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('reports an info warning when a source is not installed, with no configure-integration action', async () => {
    const source = new InMemoryCredentialSource('codex', 'Codex');
    source.setAvailable(false);
    const { service } = createHealthTestService(source);

    try {
      await service.init();

      const warnings = await service.checkHealth();

      expect(warnings).toHaveLength(1);
      const [warning] = warnings;
      expect(warning).toMatchObject({
        severity: 'info',
        title: 'Codex not detected',
      });
      expect(warning?.message).toMatch(/installation was found/i);
      // No configure-integration action when the client isn't even installed.
      expect(warning).not.toHaveProperty('action');
    } finally {
      await service.destroy();
    }
  });

  it('reports a recommended warning with a configure-integration action when getConfigIssue returns an issue', async () => {
    const source = new ConfigurableCredentialSource('claude-code', 'Claude Code');
    source.setConfigIssue({
      reason: 'Config file is using legacy plain-text mode',
      action: 'Run the migration command',
    });
    const { bus, service } = createHealthTestService(source);
    // Register a fully-wired handler so the wiring check does not add a
    // second warning and obscure the config-issue assertion.
    const cleanup = registerFullyWiredHandler(bus, 'claude-code');

    try {
      await service.init();

      const warnings = await service.checkHealth();

      const configWarning = warnings.find((w) => w.title === 'Claude Code configuration issue');
      expect(configWarning).toBeDefined();
      expect(configWarning).toMatchObject({
        severity: 'recommended',
        title: 'Claude Code configuration issue',
        message: 'Config file is using legacy plain-text mode',
        action: { kind: 'configure-integration', clientId: 'claude-code', bundle: 'account-manager' },
      });
      // Schema conformance: the produced warning must pass the contract schema.
      expect(() => ExtensionWarningSchema.parse(configWarning)).not.toThrow();
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('downgrades a throwing getConfigIssue to an info warning and continues checking other sources', async () => {
    const throwingSource = new ConfigurableCredentialSource('codex', 'Codex');
    throwingSource.setConfigIssue('throw');

    const healthySource = new InMemoryCredentialSource('claude-code', 'Claude Code');

    const bus = createBusInstance();
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [throwingSource, healthySource],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    // Register a wiring handler that handles both clients with all entries
    // installed so that wiring does not add extra warnings.
    const cleanup = bus.on(ClientSubjects.wiring.list, (ctx) => {
      const id = ctx.payload.clientId ?? 'unknown';
      ctx.setResult({
        results: [
          {
            clientId: id,
            entries: [
              {
                group: 'session-events',
                name: 'SessionStart',
                installed: true,
                command: `makaio hook received ${id} SessionStart`,
              },
            ],
          },
        ],
      });
    });

    try {
      await service.init();

      const warnings = await service.checkHealth();

      // The throwing source produces exactly one downgraded info warning.
      const codexWarning = warnings.find((w) => w.title === 'Codex health check unavailable');
      expect(codexWarning).toBeDefined();
      // Schema conformance check must run before toMatchObject to avoid
      // bun:test mutating the object with asymmetric matchers.
      expect(() => ExtensionWarningSchema.parse(codexWarning)).not.toThrow();
      expect(codexWarning).toMatchObject({
        severity: 'info',
        title: 'Codex health check unavailable',
        message: expect.stringContaining('Codex'),
      });

      // The healthy source is unaffected — it contributes no warnings.
      const claudeWarnings = warnings.filter((w) => w.title.includes('Claude Code'));
      expect(claudeWarnings).toHaveLength(0);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('reports an info warning when the wiring handler is not registered', async () => {
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // No wiring handler registered — bus.requestOptional returns { handled: false }.
    const { service } = createHealthTestService(source);

    try {
      await service.init();

      const warnings = await service.checkHealth();

      const wiringWarning = warnings.find((w) => w.title === 'Claude Code integration status unavailable');
      expect(wiringWarning).toBeDefined();
      expect(wiringWarning).toMatchObject({
        severity: 'info',
        title: 'Claude Code integration status unavailable',
      });
      expect(() => ExtensionWarningSchema.parse(wiringWarning)).not.toThrow();
    } finally {
      await service.destroy();
    }
  });
});
