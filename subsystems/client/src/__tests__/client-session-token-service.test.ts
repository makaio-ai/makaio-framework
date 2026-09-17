/**
 * Tests for {@link ClientSessionTokenService}.
 *
 * Uses a real in-memory bus so the handler registration and dispatch path is
 * exercised without mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import {
  ClientSessionTokenService,
  MAX_SESSION_TOKEN_COUNT,
  SESSION_TOKEN_TTL_MS,
  SWEEP_INTERVAL_MS,
} from '../client-session-token-service.js';

describe('ClientSessionTokenService', () => {
  let bus: IMakaioBus;
  let service: ClientSessionTokenService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClientSessionTokenService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  // -------------------------------------------------------------------------
  // session scope (no agentId)
  // -------------------------------------------------------------------------

  describe('session scope', () => {
    it('records and retrieves a token for a session', async () => {
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-session-1');

      const result = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
      });

      expect(result.token).toBe('tok-session-1');
    });

    it('returns null for an unknown session', async () => {
      const result = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-unknown',
      });

      expect(result.token).toBeNull();
    });

    it('overwrites a previous entry on a second record (compaction)', async () => {
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-first');

      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-second');

      const result = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
      });

      expect(result.token).toBe('tok-second');
    });
  });

  // -------------------------------------------------------------------------
  // subagent scope (agentId present)
  // -------------------------------------------------------------------------

  describe('subagent scope', () => {
    it('records and retrieves a token for a subagent', async () => {
      service.record(
        { clientId: 'claude-code', adapterSessionId: 'session-abc', agentId: 'agent-1' },
        'tok-subagent-1',
      );

      const result = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
        agentId: 'agent-1',
      });

      expect(result.token).toBe('tok-subagent-1');
    });

    it('keeps subagent token separate from session token for the same adapterSessionId', async () => {
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-session');
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc', agentId: 'agent-1' }, 'tok-subagent');

      const sessionResult = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
      });
      const subagentResult = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
        agentId: 'agent-1',
      });

      expect(sessionResult.token).toBe('tok-session');
      expect(subagentResult.token).toBe('tok-subagent');
    });

    it('returns null for a subagent lookup when only a session token is recorded (no silent fallback)', async () => {
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-session');

      const result = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'session-abc',
        agentId: 'agent-no-token',
      });

      // No fallback to session scope — the token identifies the generation/agent.
      expect(result.token).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // cross-client isolation
  // -------------------------------------------------------------------------

  describe('cross-client isolation', () => {
    it('stores independent entries for the same adapterSessionId under two clientIds', async () => {
      // Two clients that happen to report the same provider-local session id.
      service.record({ clientId: 'claude-code', adapterSessionId: 'shared-session-id' }, 'tok-claude');
      service.record({ clientId: 'codex', adapterSessionId: 'shared-session-id' }, 'tok-codex');

      const claudeResult = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'claude-code',
        adapterSessionId: 'shared-session-id',
      });
      const codexResult = await bus.request(ClientSubjects.session.token.get, {
        clientId: 'codex',
        adapterSessionId: 'shared-session-id',
      });

      expect(claudeResult.token).toBe('tok-claude');
      expect(codexResult.token).toBe('tok-codex');
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears the store on destroy', async () => {
      service.record({ clientId: 'claude-code', adapterSessionId: 'session-abc' }, 'tok-session-1');

      await service.destroy();

      // Reinitialize on a fresh service to verify the store was cleared.
      const freshService = new ClientSessionTokenService(bus);
      await freshService.init();

      try {
        const result = await bus.request(ClientSubjects.session.token.get, {
          clientId: 'claude-code',
          adapterSessionId: 'session-abc',
        });
        expect(result.token).toBeNull();
      } finally {
        await freshService.destroy();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TTL sweep
// ---------------------------------------------------------------------------

describe('ClientSessionTokenService — TTL sweep', () => {
  let bus: IMakaioBus;
  let service: ClientSessionTokenService;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = createBusInstance();
    service = new ClientSessionTokenService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    vi.useRealTimers();
  });

  it('removes an idle entry after SESSION_TOKEN_TTL_MS + SWEEP_INTERVAL_MS', async () => {
    service.record({ clientId: 'claude-code', adapterSessionId: 'sess-ttl' }, 'tok-idle');

    // Advance past the TTL threshold, then past the next sweep tick.
    vi.advanceTimersByTime(SESSION_TOKEN_TTL_MS + SWEEP_INTERVAL_MS);

    const result = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-ttl',
    });
    expect(result.token).toBeNull();
  });

  it('keeps an entry that was accessed before the TTL expired', async () => {
    service.record({ clientId: 'claude-code', adapterSessionId: 'sess-active' }, 'tok-alive');

    // Advance to just before the TTL, then refresh via get.
    vi.advanceTimersByTime(SESSION_TOKEN_TTL_MS - 1);
    await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-active',
    });

    // Advance past the original TTL deadline — the entry was refreshed, so it
    // should not be swept yet (lastActivity was reset by the get call).
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    const result = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-active',
    });
    expect(result.token).toBe('tok-alive');
  });
});

// ---------------------------------------------------------------------------
// LRU cap eviction
// ---------------------------------------------------------------------------

describe('ClientSessionTokenService — cap eviction', () => {
  let bus: IMakaioBus;
  let service: ClientSessionTokenService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClientSessionTokenService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('evicts the least recently active entry when MAX_SESSION_TOKEN_COUNT is exceeded', async () => {
    // Fill the store to the cap. The first inserted entry is the LRU.
    for (let i = 0; i < MAX_SESSION_TOKEN_COUNT; i++) {
      service.record({ clientId: 'claude-code', adapterSessionId: `sess-cap-${i}` }, `tok-${i}`);
    }

    // 'sess-cap-0' was inserted first and never accessed since, so it is the
    // LRU. Inserting one more entry must evict it.
    service.record({ clientId: 'claude-code', adapterSessionId: 'sess-cap-new' }, 'tok-new');

    const evicted = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-cap-0',
    });
    expect(evicted.token).toBeNull();

    const inserted = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-cap-new',
    });
    expect(inserted.token).toBe('tok-new');
  });

  it('does not evict an entry that was accessed after insertion (LRU order)', async () => {
    // Fill the store to the cap.
    for (let i = 0; i < MAX_SESSION_TOKEN_COUNT; i++) {
      service.record({ clientId: 'claude-code', adapterSessionId: `sess-lru-${i}` }, `tok-${i}`);
    }

    // Access the first entry to move it to the MRU position.
    await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-lru-0',
    });

    // Insert a new entry — 'sess-lru-1' is now the LRU (first entry not moved).
    service.record({ clientId: 'claude-code', adapterSessionId: 'sess-lru-new' }, 'tok-new');

    const notEvicted = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-lru-0',
    });
    expect(notEvicted.token).toBe('tok-0');

    const evicted = await bus.request(ClientSubjects.session.token.get, {
      clientId: 'claude-code',
      adapterSessionId: 'sess-lru-1',
    });
    expect(evicted.token).toBeNull();
  });
});
