import { describe, expect, it } from 'vitest';
import { GetAgentSchema } from '../get-agent.js';

describe('adapter.getAgent request schema', () => {
  it('requires the owning runtime instance for liveness probes', () => {
    expect(
      GetAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        agentId: 'agent-1',
      }).success,
    ).toBe(false);

    expect(
      GetAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        ownerInstanceId: 'runtime-1',
        agentId: 'agent-1',
      }).success,
    ).toBe(true);
  });
});
