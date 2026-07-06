import { describe, expect, it } from 'vitest';
import {
  SessionStorageNamespace,
  SessionStorageSetRequestSchema,
  SessionStorageSetSessionSchema,
} from '../session-storage-namespace.js';
import { MakaioSessionSchema } from '../schemas/session.js';

describe('SessionStorageSetSessionSchema', () => {
  it('accepts JSON-safe session metadata', () => {
    const result = SessionStorageSetSessionSchema.safeParse({
      sessionId: 'session-1',
      createdAt: 1,
      lastActivityAt: 1,
      agents: [],
      status: 'active',
      metadata: {
        downstream: {
          workflowId: 'workflow-1',
          values: [1, 'two', false, null],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects linked sessions without clientId', () => {
    const result = SessionStorageSetSessionSchema.safeParse({
      sessionId: 'session-1',
      createdAt: 1,
      lastActivityAt: 1,
      agents: [],
      status: 'active',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1,
        payload: {
          displayLabel: 'Chris',
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['clientId'],
        message: 'clientId is required when clientAccountId is provided',
      }),
    );
  });
});

describe('SessionStorageSetRequestSchema', () => {
  it('rejects non-boolean ifAbsent values', () => {
    const result = SessionStorageSetRequestSchema.safeParse({
      sessionId: 'session-1',
      session: {
        sessionId: 'session-1',
        createdAt: 1,
        lastActivityAt: 1,
        agents: [],
        status: 'active',
      },
      ifAbsent: 'yes',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['ifAbsent'],
      }),
    );
  });
});

describe('importUpsert request schema', () => {
  const importUpsertRequestSchema = SessionStorageNamespace.schemas.importUpsert.request;

  it('accepts an identity-only root registration with all optional registration fields', () => {
    const result = importUpsertRequestSchema.safeParse({
      externalSessionId: 'external-1',
      source: 'claude-code-cli',
      clientId: 'claude-code',
      cwd: '/workspace/project',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      metadata: {
        downstream: {
          workflowId: 'workflow-1',
          values: [1, 'two', false, null],
        },
      },
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1,
        payload: {
          displayLabel: 'Chris',
        },
      },
      importStatus: 'tracking',
      isSidechain: false,
    });

    expect(result.success).toBe(true);
  });

  it('accepts a minimal root payload without the optional registration fields', () => {
    const result = importUpsertRequestSchema.safeParse({
      externalSessionId: 'external-1',
      source: 'claude-code-cli',
      cwd: null,
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects the handler-owned 'imported' status at registration time", () => {
    const result = importUpsertRequestSchema.safeParse({
      externalSessionId: 'external-1',
      source: 'claude-code-cli',
      cwd: null,
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      importStatus: 'imported',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['importStatus'],
      }),
    );
  });
});

describe('MakaioSessionSchema isSidechain', () => {
  const baseSession = {
    sessionId: 'session-1',
    createdAt: 1,
    lastActivityAt: 1,
    agents: [],
    status: 'active',
  } as const;

  it('round-trips isSidechain when provided', () => {
    const parsed = MakaioSessionSchema.parse({ ...baseSession, isSidechain: true });

    expect(parsed.isSidechain).toBe(true);
  });

  it('leaves isSidechain undefined when omitted', () => {
    const parsed = MakaioSessionSchema.parse(baseSession);

    expect(parsed.isSidechain).toBeUndefined();
  });

  it('rejects non-boolean isSidechain values', () => {
    const result = MakaioSessionSchema.safeParse({ ...baseSession, isSidechain: 'yes' });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['isSidechain'],
      }),
    );
  });
});
