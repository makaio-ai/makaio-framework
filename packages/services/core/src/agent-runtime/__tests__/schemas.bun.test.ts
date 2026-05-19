import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import type { AgentSelection } from '@makaio/contracts';
import { AgentRuntimeSchemas, AgentRuntimeSelectionSchema, type AgentRuntimeSelection } from '../schemas.js';

type Assert<T extends true> = T;
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type AgentRuntimeSelectionSchemaMatchesExport = Assert<
  IsExact<z.infer<typeof AgentRuntimeSelectionSchema>, AgentRuntimeSelection>
>;
type CanonicalModelExcludedFromRuntimeSelection = Assert<
  IsExact<Extract<AgentRuntimeSelection, { kind: 'canonical-model' }>, never>
>;
type AdapterSelectionStillAllowedAtRuntime = Assert<
  IsExact<Extract<AgentRuntimeSelection, { kind: 'adapter' }>, Extract<AgentSelection, { kind: 'adapter' }>>
>;

describe('AgentRuntimeSchemas', () => {
  const spawnRequest = AgentRuntimeSchemas.spawn.request;

  it('excludes transient canonical-model selections from the runtime selection type', () => {
    expect<AgentRuntimeSelectionSchemaMatchesExport>(true).toBe(true);
    expect<CanonicalModelExcludedFromRuntimeSelection>(true).toBe(true);
    expect<AdapterSelectionStillAllowedAtRuntime>(true).toBe(true);
  });

  it('accepts runtime persona selections', () => {
    const result = spawnRequest.safeParse({
      agent: { kind: 'persona', personaName: 'Explorer' },
      prompt: 'Explore the codebase',
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects unresolved canonical-model selections at the runtime spawn boundary', () => {
    const result = spawnRequest.safeParse({
      agent: { kind: 'canonical-model', model: 'sonnet' },
      prompt: 'Explore the codebase',
      sessionId: 'session-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['agent', 'kind']);
    expect(result.error?.issues[0]?.message).toContain('resolve before agentRuntime.spawn');
  });
});
