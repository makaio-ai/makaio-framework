import { describe, expect, it } from 'vitest';
import { StopAgentSchema } from '../stop-agent.js';

describe('StopAgentSchema', () => {
  it('requires the exact runtime owner for stop requests', () => {
    const request = { adapterId: 'adapter-1', agentId: 'agent-1' };

    expect(StopAgentSchema.request.safeParse(request).success).toBe(false);
    expect(StopAgentSchema.request.safeParse({ ...request, ownerInstanceId: 'runtime-1' }).success).toBe(true);
  });
});
