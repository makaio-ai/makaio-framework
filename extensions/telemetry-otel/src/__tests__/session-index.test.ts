import { describe, expect, it } from 'vitest';
import { SessionIndex } from '../collector/session-index.js';

describe('SessionIndex', () => {
  it('links sessions to execution frames and evicts by execution', () => {
    const index = new SessionIndex();

    index.link('sess-1', 'wfx-1', 'frame-1');
    index.link('sess-2', 'wfx-2', 'frame-2');

    expect(index.lookup('sess-1')).toEqual({ executionId: 'wfx-1', frameId: 'frame-1' });

    index.evictExecution('wfx-1');

    expect(index.lookup('sess-1')).toBeUndefined();
    expect(index.lookup('sess-2')).toEqual({ executionId: 'wfx-2', frameId: 'frame-2' });
  });
});
