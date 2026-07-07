import { describe, it, expect } from 'vitest';
import { AgentSubjects } from '@makaio/contracts';

import { toImportSegment } from '../../log-importer/types.js';
import type {
  ImportSegmentTurn,
  NormalizedEvent,
  ProcessLogFileResult,
  StorageMessagePayload,
} from '../../log-importer/types.js';

/**
 * Build a minimal agent-started event for segment conversion tests.
 * @param adapterSessionId - Adapter session ID carried in the payload.
 * @returns A normalized `agent.started` event.
 */
function startedEvent(adapterSessionId: string): NormalizedEvent {
  return {
    subject: AgentSubjects.started,
    payload: {
      agentId: 'main',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId,
      model: 'test-model',
      cwd: null,
      startMode: 'fresh',
    },
  };
}

/**
 * Build a storage-ready message payload for segment conversion tests.
 * @param adapterMessageId - Deterministic adapter message ID.
 * @param adapterSessionId - Adapter session ID the message belongs to.
 * @returns A minimal user message payload.
 */
function messagePayload(adapterMessageId: string, adapterSessionId: string): StorageMessagePayload {
  return {
    adapterMessageId,
    role: 'user',
    contentText: 'hello',
    blocks: [{ type: 'text', content: 'hello' }],
    agentId: 'main',
    adapterSessionId,
    timestamp: 1_000,
  };
}

/**
 * Build a full {@link ProcessLogFileResult} with configurable structural fields.
 * @param adapterSessionId - Adapter session ID for the result.
 * @param overrides - Optional structural fields to merge onto the base result.
 * @returns A hand-built process result suitable for {@link toImportSegment}.
 */
function processResult(
  adapterSessionId: string,
  overrides: Partial<
    Pick<ProcessLogFileResult, 'turns' | 'isSidechain' | 'compressChildren' | 'compactionMetadata'>
  > = {},
): ProcessLogFileResult {
  return {
    adapterSessionId,
    sessionEvent: startedEvent(adapterSessionId),
    messageEvents: [startedEvent(adapterSessionId)],
    messagePayloads: [messagePayload(`${adapterSessionId}-msg-1`, adapterSessionId)],
    lineage: { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null },
    ...overrides,
  };
}

describe('toImportSegment', () => {
  it('copies turns and isSidechain onto the segment', () => {
    const turns: ImportSegmentTurn[] = [
      {
        turnAnchorId: 'session-1-msg-1',
        adapterMessageIds: ['session-1-msg-1', 'session-1-msg-2'],
        startedAt: 1_000,
        completedAt: 2_000,
        status: 'completed',
      },
    ];
    const segment = toImportSegment(processResult('session-1', { turns, isSidechain: true }));

    expect(segment.turns).toEqual(turns);
    expect(segment.isSidechain).toBe(true);
  });

  it('preserves isSidechain: false explicitly', () => {
    const segment = toImportSegment(processResult('session-1', { isSidechain: false }));

    expect(segment.isSidechain).toBe(false);
  });

  it('omits turns and isSidechain when absent on the result', () => {
    const segment = toImportSegment(processResult('session-1'));

    expect('turns' in segment).toBe(false);
    expect('isSidechain' in segment).toBe(false);
  });

  it('copies structural fields recursively for compress children', () => {
    const childTurns: ImportSegmentTurn[] = [
      {
        turnAnchorId: 'session-2-msg-1',
        adapterMessageIds: ['session-2-msg-1'],
        startedAt: 3_000,
        completedAt: 4_000,
      },
    ];
    const child = processResult('session-2', {
      turns: childTurns,
      isSidechain: false,
      compactionMetadata: { trigger: 'auto', preTokens: 42, timestamp: 3_000 },
    });
    const segment = toImportSegment(processResult('session-1', { compressChildren: [child] }));

    expect(segment.children).toHaveLength(1);
    expect(segment.children?.[0]?.turns).toEqual(childTurns);
    expect(segment.children?.[0]?.isSidechain).toBe(false);
    expect(segment.children?.[0]?.compaction).toEqual({ trigger: 'auto', preTokens: 42, timestamp: 3_000 });
  });

  it('still strips bus-emission fields', () => {
    const segment = toImportSegment(processResult('session-1', { turns: [], isSidechain: true }));

    expect(segment).not.toHaveProperty('sessionEvent');
    expect(segment).not.toHaveProperty('messageEvents');
  });
});
