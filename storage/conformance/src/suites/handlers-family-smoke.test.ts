/**
 * Conformance suite: one write + one read per remaining handler family.
 *
 * Purpose: verify that each handler family was fully adopted through the
 * dialect seam and executes correctly on both dialects. A table-not-found
 * error on Postgres is the defining failure mode this suite pins.
 *
 * Each describe block:
 * - Creates a fresh database context (central chain applied).
 * - Registers only the handlers under test.
 * - Performs exactly one write and one read via the family's Subjects.
 * - Asserts the round-trip value.
 * - Cleans up in afterAll in reverse registration order.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '@makaio/contracts';
import { registerDrizzleWorkflowStorage, WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import {
  registerDrizzleSupervisorRuntimeStorage,
  SupervisorRuntimeStorageSubjects,
} from '@makaio/subsystem-native-session-supervisor';
import {
  ClientRuntimeStorageSubjects,
  ClientProfileStorageSubjects,
  ClientBinaryStorageSubjects,
  registerDrizzleRuntimeStorage,
  registerDrizzleProfileStorage,
  registerDrizzleClientBinaryStorage,
} from '@makaio/subsystem-client';
import { registerDrizzleLogImportStorage, LogImportSubjects } from '@makaio/services-log-import';
import {
  registerDrizzleSessionStorage,
  registerDrizzleImportCursorStorage,
  registerDrizzleMessageStorage,
  registerDrizzleMessageRoutingStorage,
  SessionStorageSubjects,
  MessageStorageSubjects,
  MessageRoutingSubjects,
} from '@makaio/services-core/session';
import { HarnessStorageSubjects, registerDrizzleHarnessStorage } from '@makaio/services-core/harness';
import { ImportCursorStorageSubjects } from '@makaio/ai-adapters-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { StorageConformanceConfig } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { makeSession } from '../harness/fixture-session.js';

// ---------------------------------------------------------------------------
// Lifecycle helper shared by every family block
// ---------------------------------------------------------------------------

/**
 * Wire one handler family's database-context lifecycle: a fresh migrated
 * context in beforeAll, handler registration via the provided callback, and
 * reverse-order cleanup in afterAll (handlers first, then the database).
 * @param config - Active conformance config.
 * @param register - Registers the family's handlers on the global bus and
 *   returns their cleanup functions in registration order.
 */
function useFamilyContext(config: StorageConformanceConfig, register: (db: MakaioDatabase) => Array<() => void>): void {
  const getCtx = useSuiteDatabaseContext(config);
  let cleanups: Array<() => void> = [];

  beforeAll(() => {
    cleanups = register(getCtx().db);
  });

  afterAll(() => {
    // Handlers unregister first; the context helper's afterAll (registered
    // earlier, therefore run later) releases the database afterwards.
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Inline workflow definition factory (DO NOT import from workflow-engine tests)
// ---------------------------------------------------------------------------

/**
 * Build a minimal workflow definition compatible with WorkflowStorageSubjects.set.
 * @param id - Workflow identifier; defaults to a random value.
 * @returns WorkflowDefinition for use in smoke assertions.
 */
function makeWorkflowDefinition(id?: string) {
  const wfId = id ?? `wf-smoke-${crypto.randomUUID()}`;
  return {
    id: wfId,
    name: `smoke-test-workflow-${wfId}`,
    description: 'Conformance smoke test workflow',
    root: {
      type: 'sequence' as const,
      id: `${wfId}__root`,
      nodes: [{ type: 'station' as const, id: 'step-1', prompt: 'Do the work' }],
    },
    scope: { type: 'global' as const },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('handlers-family-smoke', (config) => {
  // ─── Workflow Engine ────────────────────────────────────────────────────

  describe('workflow engine — registerDrizzleWorkflowStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleWorkflowStorage(MakaioBus, db)]);

    it('set+get workflow definition round-trips', async () => {
      const workflow = makeWorkflowDefinition();
      const setResult = await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
      expect(setResult.id).toBe(workflow.id);

      const getResult = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
      expect(getResult.workflow).not.toBeNull();
      expect(getResult.workflow?.id).toBe(workflow.id);
      expect(getResult.workflow?.name).toBe(workflow.name);
    });

    it('registers and settles an external execution with an exact WorkLog frame', async () => {
      const executionId = `wfx-ext-conformance-${crypto.randomUUID()}`;
      const frameId = `${executionId}:station`;
      await MakaioBus.request(WorkflowStorageSubjects.setExternalExecutionStart, {
        execution: {
          id: executionId,
          workflowId: 'conformance-external-workflow',
          status: 'running',
          inputs: {},
          startedAt: 1_000,
          scope: { type: 'global' },
        },
        frame: {
          executionId,
          frameId,
          nodeId: 'station',
          nodeType: 'station',
          path: [frameId],
          status: 'running',
          attempt: 0,
          startedAt: 1_000,
        },
      });

      await expect(
        MakaioBus.request(WorkflowStorageSubjects.settleExternalExecution, {
          executionId,
          status: 'completed',
          completedAt: 1_250,
          frame: {
            executionId,
            frameId,
            nodeId: 'station',
            nodeType: 'station',
            path: [frameId],
            status: 'completed',
            attempt: 0,
            startedAt: 1_000,
            completedAt: 1_250,
            durationMs: 250,
          },
        }),
      ).resolves.toEqual({ success: true });

      await expect(MakaioBus.request(WorkflowSubjects.worklog.frame.get, { frameId })).resolves.toMatchObject({
        frame: {
          executionId,
          frameId,
          status: 'completed',
          completedAt: 1_250,
          durationMs: 250,
        },
      });
    });
  });

  // ─── Supervisor Runtime ─────────────────────────────────────────────────

  describe('native session supervisor — registerDrizzleSupervisorRuntimeStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleSupervisorRuntimeStorage(MakaioBus, db)]);

    it('set+get supervisor runtime round-trips', async () => {
      const supervisorSessionId = `sup-${crypto.randomUUID()}`;
      const runtime = {
        supervisorSessionId,
        clientId: `client-${crypto.randomUUID()}`,
        pid: null,
        status: 'running' as const,
        cwd: '/tmp',
        command: 'node',
        args: [],
        startedAt: Date.now(),
      };

      const setResult = await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, runtime);
      expect(setResult.success).toBe(true);

      const getResult = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, { supervisorSessionId });
      expect(getResult.runtime).not.toBeNull();
      expect(getResult.runtime?.supervisorSessionId).toBe(supervisorSessionId);
    });
  });

  // ─── Client: Runtime Storage ─────────────────────────────────────────────

  describe('client subsystem — registerDrizzleRuntimeStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleRuntimeStorage(MakaioBus, db)]);

    it('upsert+loadAll client runtime round-trips', async () => {
      const now = Date.now();
      const clientRuntimeId = `cr-${crypto.randomUUID()}`;
      const record = {
        clientRuntimeId,
        clientId: `client-${crypto.randomUUID()}`,
        status: 'observed' as const,
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const upsertResult = await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, record);
      expect(upsertResult.success).toBe(true);

      const loadResult = await MakaioBus.request(ClientRuntimeStorageSubjects.loadAll, {});
      const found = loadResult.records.find((r) => r.clientRuntimeId === clientRuntimeId);
      expect(found).toBeDefined();
      expect(found?.clientRuntimeId).toBe(clientRuntimeId);
    });
  });

  // ─── Client: Profile Storage ─────────────────────────────────────────────

  describe('client subsystem — registerDrizzleProfileStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleProfileStorage(MakaioBus, db)]);

    it('set+get client profile round-trips', async () => {
      const now = Date.now();
      const clientId = `client-${crypto.randomUUID()}`;
      const profileName = `profile-smoke-${crypto.randomUUID()}`;
      const record = {
        id: `prof-${crypto.randomUUID()}`,
        clientId,
        name: profileName,
        description: null,
        configDir: '/tmp/conf',
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };

      await MakaioBus.request(ClientProfileStorageSubjects.set, record);

      const getResult = await MakaioBus.request(ClientProfileStorageSubjects.get, {
        clientId,
        name: profileName,
      });
      expect(getResult.record).not.toBeNull();
      expect(getResult.record?.name).toBe(profileName);
    });
  });

  // ─── Client: Binary Storage ──────────────────────────────────────────────

  describe('client subsystem — registerDrizzleClientBinaryStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleClientBinaryStorage(MakaioBus, db)]);

    it('upsertState+getState client binary state round-trips', async () => {
      const clientId = `client-bin-${crypto.randomUUID()}`;
      const stateRecord = {
        clientId,
        activeVersion: '1.2.3',
        updatedAt: Date.now(),
      };

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, stateRecord);

      const getResult = await MakaioBus.request(ClientBinaryStorageSubjects.getState, { clientId });
      expect(getResult.state).not.toBeNull();
      expect(getResult.state?.clientId).toBe(clientId);
      expect(getResult.state?.activeVersion).toBe('1.2.3');
    });
  });

  // ─── Log Import Storage ──────────────────────────────────────────────────

  describe('log import — registerDrizzleLogImportStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleLogImportStorage(MakaioBus, db)]);

    it('setMode+getMode log import round-trips', async () => {
      const adapterName = `adapter-smoke-${crypto.randomUUID()}`;

      await MakaioBus.request(LogImportSubjects.setMode, { adapterName, mode: 'import' });

      const getResult = await MakaioBus.request(LogImportSubjects.getMode, { adapterName });
      expect(getResult.mode).toBe('import');
    });
  });

  // ─── Harness Storage ─────────────────────────────────────────────────────

  describe('harness — registerDrizzleHarnessStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleHarnessStorage(MakaioBus, db)]);

    it('set+get harness definition round-trips', async () => {
      const harnessId = `harness-${crypto.randomUUID()}`;
      const harness = {
        id: harnessId,
        name: `smoke-harness-${harnessId}`,
        adapterName: 'codex-app-server',
        approvalPolicy: 'always-ask' as const,
        nativeTools: { enabled: ['bash'], disabled: [] },
        registryTools: { enabled: [], disabled: [] },
        isDefault: false,
        enabled: true,
      };

      const setResult = await MakaioBus.request(HarnessStorageSubjects.set, { harness });
      expect(setResult.id).toBe(harnessId);

      const getResult = await MakaioBus.request(HarnessStorageSubjects.get, { id: harnessId });
      expect(getResult.harness).not.toBeNull();
      expect(getResult.harness?.name).toBe(harness.name);
    });
  });

  // ─── Import Cursor Storage ───────────────────────────────────────────────

  describe('import cursor — registerDrizzleImportCursorStorage', () => {
    useFamilyContext(config, (db) => [registerDrizzleImportCursorStorage(MakaioBus, db)]);

    it('set+get import cursor round-trips', async () => {
      const filePath = `/tmp/smoke-${crypto.randomUUID()}.jsonl`;

      await MakaioBus.request(ImportCursorStorageSubjects.set, {
        filePath,
        bytesRead: 4096,
        lastModified: new Date().toISOString(),
      });

      const getResult = await MakaioBus.request(ImportCursorStorageSubjects.get, { filePath });
      expect(getResult.cursor).not.toBeNull();
      expect(getResult.cursor?.filePath).toBe(filePath);
      expect(getResult.cursor?.bytesRead).toBe(4096);
    });
  });

  // ─── Message Routing Storage ─────────────────────────────────────────────

  describe('message routing — registerDrizzleMessageRoutingStorage', () => {
    // message_routing.message_id has an FK to messages, which in turn has an
    // FK to sessions — both parents must be persisted through their handlers.
    useFamilyContext(config, (db) => [
      registerDrizzleSessionStorage(MakaioBus, db),
      registerDrizzleMessageStorage(MakaioBus, db),
      registerDrizzleMessageRoutingStorage(MakaioBus, db),
    ]);

    it('record+getByMessage message routing round-trips', async () => {
      const sessionId = `sess-routing-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const appendResult = await MakaioBus.request(MessageStorageSubjects.append, {
        message: {
          turnId: null,
          sessionId,
          role: 'user',
          contentText: 'routing smoke message',
          blocks: [{ type: 'text', content: 'routing smoke message' }],
          timestamp: Date.now(),
        },
        emitEvent: false,
      });
      const messageId = appendResult.message.messageId;
      const agentId = `agent-${crypto.randomUUID()}`;

      const recordResult = await MakaioBus.request(MessageRoutingSubjects.record, {
        messageId,
        agentId,
        status: 'sent',
        timestamp: Date.now(),
      });
      expect(recordResult.success).toBe(true);

      const getResult = await MakaioBus.request(MessageRoutingSubjects.getByMessage, { messageId });
      expect(getResult.routing).toHaveLength(1);
      expect(getResult.routing[0].messageId).toBe(messageId);
      expect(getResult.routing[0].agentId).toBe(agentId);
    });
  });
});
