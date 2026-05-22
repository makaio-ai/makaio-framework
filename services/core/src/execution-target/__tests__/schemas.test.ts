import { describe, expect, it } from 'vitest';
import { ExecutionTargetInputSchema } from '@makaio/services-core/execution-target/schemas';

describe('ExecutionTargetInputSchema', () => {
  it('defaults gitCredentialMode to token for container-isolated targets', () => {
    const parsed = ExecutionTargetInputSchema.parse({
      id: 'target-1',
      name: 'Container Isolated',
      type: 'container-isolated',
      scope: 'default',
      enabled: true,
      busMode: 'host',
    });

    if (parsed.type !== 'container-isolated') {
      throw new Error('Expected container-isolated target');
    }

    expect(parsed.gitCredentialMode).toBe('token');
  });

  it('preserves explicit gitCredentialMode for container-isolated targets', () => {
    const parsed = ExecutionTargetInputSchema.parse({
      id: 'target-2',
      name: 'Container Isolated',
      type: 'container-isolated',
      scope: 'default',
      enabled: true,
      busMode: 'host',
      gitCredentialMode: 'ssh-agent',
    });

    if (parsed.type !== 'container-isolated') {
      throw new Error('Expected container-isolated target');
    }

    expect(parsed.gitCredentialMode).toBe('ssh-agent');
  });
});
