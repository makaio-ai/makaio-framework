import { afterEach, describe, expect, it } from 'bun:test';
import type { UiContextSnapshot } from '@makaio/contracts';
import { defaultUiContext, useWindowContext } from './window-context-store.js';

function resetWindowContextStore(): void {
  useWindowContext.persist.clearStorage();
  useWindowContext.setState({
    activePaneId: null,
    uiContext: {
      level: defaultUiContext.level,
      values: { ...defaultUiContext.values },
    },
    windowId: null,
  });
}

describe('useWindowContext', () => {
  afterEach(() => {
    resetWindowContextStore();
  });

  it('stores an owned copy of uiContext values on write', () => {
    const values: { session: string | null } = { session: 'session-a' };
    const uiContext: UiContextSnapshot = {
      level: 'root',
      values,
    };

    useWindowContext.getState().setUiContext(uiContext);
    values.session = 'session-b';

    expect(useWindowContext.getState().uiContext.values.session).toBe('session-a');
    expect(useWindowContext.getState().uiContext.values).not.toBe(values);
  });

  it('clears to an owned default uiContext copy and resets active pane state', () => {
    useWindowContext.getState().setUiContext({
      level: 'root',
      values: { session: 'session-a' },
    });
    useWindowContext.getState().setActivePaneId('pane-a');

    useWindowContext.getState().clearUiContext();

    expect(useWindowContext.getState().uiContext).toEqual(defaultUiContext);
    expect(useWindowContext.getState().uiContext).not.toBe(defaultUiContext);
    expect(useWindowContext.getState().uiContext.values).not.toBe(defaultUiContext.values);
    expect(useWindowContext.getState().activePaneId).toBeNull();
  });
});
