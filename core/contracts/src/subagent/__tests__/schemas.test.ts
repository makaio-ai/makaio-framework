import { describe, expect, it } from 'vitest';
import { SubagentConfigSchema } from '../schemas.js';

describe('SubagentConfigSchema', () => {
  it('preserves reasoningEffort on subagent configs', () => {
    const config = SubagentConfigSchema.parse({
      task: 'Review this change',
      adapterName: 'claude-code',
      reasoningEffort: 'high',
    });

    expect(config).toMatchObject({ reasoningEffort: 'high' });
  });
});
