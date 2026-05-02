/**
 * Tests for the global `client.wiring.list` aggregation handler.
 *
 * Verifies that {@link ClientRuntimeService} correctly fans out the list request
 * to enabled clients, respects the optional `clientId` filter, skips disabled
 * clients, and silently omits clients whose per-client handler is not registered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';
import { ClientRuntimeService } from '../client-runtime-service.js';
import { createClientWiringListSubjectDef } from '../create-client-wiring-list-subject.js';
import { ClientWiringAggregatedResultSchema, type ClientWiringEntry } from '../wiring-schemas.js';
import { makeClientRecord } from './helpers.js';

const CLAUDE_CODE_ENTRY: ClientWiringEntry = {
  group: 'session-events',
  name: 'PreToolUse',
  installed: true,
  command: 'makaio hook received claude-code PreToolUse',
};

const CODEX_ENTRY: ClientWiringEntry = {
  group: 'session-events',
  name: 'PreToolUse',
  installed: false,
  command: 'makaio hook received codex PreToolUse',
};

describe('ClientRuntimeService — client.wiring.list', () => {
  let bus: IMakaioBus;
  let service: ClientRuntimeService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClientRuntimeService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('ClientWiringAggregatedResultSchema', () => {
    it('parses a valid aggregated result', () => {
      const result = ClientWiringAggregatedResultSchema.parse({
        clientId: 'claude-code',
        entries: [CLAUDE_CODE_ENTRY],
      });
      expect(result.clientId).toBe('claude-code');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual(CLAUDE_CODE_ENTRY);
    });
  });

  describe('client.wiring.list handler', () => {
    it('aggregates wiring entries from all enabled clients that respond', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'claude-code',
          name: 'Claude Code',
          packageName: '@makaio/client-claude-code',
          enabled: true,
        }),
        makeClientRecord({
          id: 'codex',
          name: 'Codex',
          packageName: '@makaio/client-codex',
          enabled: true,
        }),
      ];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      const cleanupClaude = bus.on(createClientWiringListSubjectDef('claude-code'), (ctx) => {
        ctx.setResult({ entries: [CLAUDE_CODE_ENTRY] });
      });
      const cleanupCodex = bus.on(createClientWiringListSubjectDef('codex'), (ctx) => {
        ctx.setResult({ entries: [CODEX_ENTRY] });
      });

      const result = await bus.request(ClientSubjects.wiring.list, { makaioCommand: 'makaio' });

      cleanupStorage();
      cleanupClaude();
      cleanupCodex();

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({ clientId: 'claude-code', entries: [CLAUDE_CODE_ENTRY] });
      expect(result.results[1]).toEqual({ clientId: 'codex', entries: [CODEX_ENTRY] });
    });

    it('skips disabled clients', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'claude-code',
          name: 'Claude Code',
          packageName: '@makaio/client-claude-code',
          enabled: true,
        }),
        makeClientRecord({
          id: 'disabled-client',
          name: 'Disabled',
          packageName: '@makaio/client-disabled',
          enabled: false,
        }),
      ];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      const cleanupClaude = bus.on(createClientWiringListSubjectDef('claude-code'), (ctx) => {
        ctx.setResult({ entries: [CLAUDE_CODE_ENTRY] });
      });
      const cleanupDisabled = bus.on(createClientWiringListSubjectDef('disabled-client'), () => {
        throw new Error('disabled-client handler must not be called');
      });

      const result = await bus.request(ClientSubjects.wiring.list, { makaioCommand: 'makaio' });

      cleanupStorage();
      cleanupClaude();
      cleanupDisabled();

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.clientId).toBe('claude-code');
    });

    it('silently skips clients whose per-client handler is not registered', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'claude-code',
          name: 'Claude Code',
          packageName: '@makaio/client-claude-code',
          enabled: true,
        }),
        makeClientRecord({
          id: 'codex',
          name: 'Codex',
          packageName: '@makaio/client-codex',
          enabled: true,
        }),
      ];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      // Only register a handler for claude-code; codex has no handler.
      const cleanupClaude = bus.on(createClientWiringListSubjectDef('claude-code'), (ctx) => {
        ctx.setResult({ entries: [CLAUDE_CODE_ENTRY] });
      });

      const result = await bus.request(ClientSubjects.wiring.list, { makaioCommand: 'makaio' });

      cleanupStorage();
      cleanupClaude();

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.clientId).toBe('claude-code');
    });

    it('filters by clientId when provided', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'claude-code',
          name: 'Claude Code',
          packageName: '@makaio/client-claude-code',
          enabled: true,
        }),
        makeClientRecord({
          id: 'codex',
          name: 'Codex',
          packageName: '@makaio/client-codex',
          enabled: true,
        }),
      ];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      const cleanupClaude = bus.on(createClientWiringListSubjectDef('claude-code'), (ctx) => {
        ctx.setResult({ entries: [CLAUDE_CODE_ENTRY] });
      });
      const cleanupCodex = bus.on(createClientWiringListSubjectDef('codex'), () => {
        throw new Error('codex handler must not be called when filtering by claude-code');
      });

      const result = await bus.request(ClientSubjects.wiring.list, {
        clientId: 'claude-code',
        makaioCommand: 'makaio',
      });

      cleanupStorage();
      cleanupClaude();
      cleanupCodex();

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.clientId).toBe('claude-code');
    });

    it('returns empty results when no enabled clients exist', async () => {
      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: [] });
      });

      const result = await bus.request(ClientSubjects.wiring.list, { makaioCommand: 'makaio' });
      cleanupStorage();

      expect(result.results).toHaveLength(0);
    });

    it('excludes a failing client and returns results from the healthy client', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'client-a',
          name: 'Client A',
          packageName: '@makaio/client-a',
          enabled: true,
        }),
        makeClientRecord({
          id: 'client-b',
          name: 'Client B',
          packageName: '@makaio/client-b',
          enabled: true,
        }),
      ];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      const cleanupA = bus.on(createClientWiringListSubjectDef('client-a'), (ctx) => {
        ctx.setResult({ entries: [CLAUDE_CODE_ENTRY] });
      });
      const cleanupB = bus.on(createClientWiringListSubjectDef('client-b'), () => {
        throw new Error('client-b I/O failure');
      });

      const result = await bus.request(ClientSubjects.wiring.list, { makaioCommand: 'makaio' });

      cleanupStorage();
      cleanupA();
      cleanupB();

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ clientId: 'client-a', entries: [CLAUDE_CODE_ENTRY] });
    });

    it('rejects the aggregator request when projectDir is non-absolute', async () => {
      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: [] });
      });

      await expect(
        bus.request(ClientSubjects.wiring.list, {
          projectDir: 'relative/path',
          makaioCommand: 'makaio',
        }),
      ).rejects.toThrow('projectDir must be an absolute path');

      cleanupStorage();
    });

    it('forwards projectDir and makaioCommand to per-client handlers', async () => {
      const storedClients: ClientRecord[] = [
        makeClientRecord({
          id: 'claude-code',
          name: 'Claude Code',
          packageName: '@makaio/client-claude-code',
          enabled: true,
        }),
      ];

      const capturedPayloads: Array<{ projectDir?: string; makaioCommand?: string }> = [];

      const cleanupStorage = bus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: storedClients });
      });
      const cleanupClaude = bus.on(createClientWiringListSubjectDef('claude-code'), (ctx) => {
        capturedPayloads.push({ projectDir: ctx.payload.projectDir, makaioCommand: ctx.payload.makaioCommand });
        ctx.setResult({ entries: [] });
      });

      await bus.request(ClientSubjects.wiring.list, {
        projectDir: '/home/user/project',
        makaioCommand: 'makaio-dev',
      });

      cleanupStorage();
      cleanupClaude();

      expect(capturedPayloads).toHaveLength(1);
      expect(capturedPayloads[0]).toEqual({
        projectDir: '/home/user/project',
        makaioCommand: 'makaio-dev',
      });
    });
  });
});
