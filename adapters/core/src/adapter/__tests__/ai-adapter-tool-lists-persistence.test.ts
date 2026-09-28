import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { prepareColdRehydrate } from '../ai-adapter-rehydrate-preflight.js';
import { providerKeyPublicationFor } from '../adapter-provider-key-publication.js';
import { createTestAdapter, registerStartReservationAuthority } from './shared.js';

/**
 * Tool lists round-trip through the agent row: an adapter-owned start writes
 * them, and a cold rehydrate hands them back to the replacement connector.
 * `[]` is a real list ("nothing allowed") and must survive both directions.
 */
describe('agent row tool lists', () => {
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(() => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
  });

  describe('prepareColdRehydrate', () => {
    /**
     * Serve one persisted agent row and run the preflight against it.
     * @param toolLists - Tool list fields to put on the persisted row
     * @returns The preflight result
     */
    async function preflightWith(toolLists: Pick<MakaioSessionAgent, 'allowedTools' | 'disallowedTools'>) {
      cleanupFns.push(
        MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
          ctx.setResult({
            agent: {
              agentId: ctx.payload.agentId,
              adapterId: 'test-adapter-id',
              adapterName: 'test-adapter',
              sessionId: 'persisted-session',
              role: 'lead',
              status: 'idle',
              model: 'persisted-model',
              cwd: os.tmpdir(),
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              ...toolLists,
            },
          });
        }),
      );
      return prepareColdRehydrate(
        { globalBus: MakaioBus, resolveMcpSessionContext: async () => undefined },
        'persisted-agent',
        { publication: providerKeyPublicationFor({ callerOwnsAgentRow: false }) },
      );
    }

    it('passes a persisted empty allowlist and a denylist into the creation request', async () => {
      const result = await preflightWith({ allowedTools: [], disallowedTools: ['shell_exec'] });

      if (!('agentCreationRequest' in result)) throw new Error(`Expected a preflight, got ${result.message}`);
      expect(result.agentCreationRequest.allowedTools).toEqual([]);
      expect(result.agentCreationRequest.disallowedTools).toEqual(['shell_exec']);
    });

    it('omits the lists when the row has none', async () => {
      const result = await preflightWith({});

      if (!('agentCreationRequest' in result)) throw new Error(`Expected a preflight, got ${result.message}`);
      expect('allowedTools' in result.agentCreationRequest).toBe(false);
      expect('disallowedTools' in result.agentCreationRequest).toBe(false);
    });
  });

  describe('adapter-owned start', () => {
    it('stores an empty allowlist and a denylist on the agent row', async () => {
      const { adapter } = createTestAdapter('test-adapter-tool-lists');
      const storedRows: MakaioSessionAgent[] = [];
      cleanupFns.push(
        registerStartReservationAuthority(),
        MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
          storedRows.push(ctx.payload.agent);
          ctx.setResult({ success: true });
        }),
      );
      await adapter.init();

      try {
        const result = await MakaioBus.request(AdapterSubjects.startAgent, {
          adapterId: adapter.adapterId,
          role: 'lead',
          mode: 'create',
          initialMessage: 'hello',
          allowedTools: [],
          disallowedTools: ['shell_exec'],
        });

        expect(result.success).toBe(true);
        expect(storedRows.length).toBeGreaterThan(0);
        for (const row of storedRows) {
          expect(row.allowedTools).toEqual([]);
          expect(row.disallowedTools).toEqual(['shell_exec']);
        }
      } finally {
        await adapter.closeAsync();
      }
    });
  });
});
