import { describe, expect, it } from 'bun:test';
import { StartAgentSchema } from '../adapter/index.js';

describe('StartAgentSchema', () => {
  it('rejects an empty client profile name', () => {
    const result = StartAgentSchema.request.safeParse({
      adapterId: 'adapter-1',
      role: 'lead',
      clientProfileName: '',
    });

    if (result.success) {
      throw new Error('Expected empty clientProfileName to fail validation');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['clientProfileName'] })]),
    );
  });
});
