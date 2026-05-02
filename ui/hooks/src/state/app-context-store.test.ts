import { describe, expect, it } from 'vitest';
import type { AgentSelection } from '@makaio/contracts';
import { mergePersistedAppContextState, type AppContextState } from './app-context-store.js';

const currentState: AppContextState = {
  // Framework standalone validation only includes the framework-native union.
  defaultSelection: { kind: 'adapter', adapterName: 'claude-code', model: 'opus' } as AgentSelection,
  setDefaultSelection: () => undefined,
};

describe('mergePersistedAppContextState', () => {
  it('keeps the current state when the persisted selection is missing or nullish', () => {
    expect(mergePersistedAppContextState({}, currentState)).toBe(currentState);
    expect(mergePersistedAppContextState({ defaultSelection: undefined }, currentState)).toBe(currentState);
    expect(mergePersistedAppContextState({ defaultSelection: null }, currentState)).toBe(currentState);
  });

  it('merges a valid persisted selection into the current state', () => {
    const merged = mergePersistedAppContextState(
      {
        defaultSelection: {
          kind: 'adapter',
          adapterName: 'claude-code',
          model: 'opus',
        },
      },
      currentState,
    );

    expect(merged).not.toBe(currentState);
    expect(merged.defaultSelection).toEqual({
      kind: 'adapter',
      adapterName: 'claude-code',
      model: 'opus',
    });
  });
});
