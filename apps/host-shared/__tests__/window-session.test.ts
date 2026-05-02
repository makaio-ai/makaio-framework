import { describe, expect, it, vi } from 'vitest';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import {
  loadWindowSession,
  saveWindowSession,
  type WindowManagerState,
  type WindowSessionBusClient,
  type WindowSessionWindowEntry,
  type WindowSessionWindowSource,
} from '../src/window-session.js';

const HOST_SCOPE = 'test-host';
const REGISTRATION_ID_PROJECT = 'makaio.project-window:main';
const REGISTRATION_ID_CHAT = 'makaio.chat:main';

function createBusClientStub(requestImpl: WindowSessionBusClient['request']): WindowSessionBusClient {
  return { request: requestImpl };
}

function createWindowSourceStub(overrides?: {
  listWindows?: WindowSessionWindowSource['listWindows'];
  getWindow?: WindowSessionWindowSource['getWindow'];
}): WindowSessionWindowSource {
  return {
    listWindows: overrides?.listWindows ?? (() => []),
    getWindow: overrides?.getWindow ?? (() => undefined),
  };
}

describe('window-session', () => {
  it('saves only windows with live bounds and writes the injected host scope', async () => {
    const request = vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({ success: true });
    const busClient = createBusClientStub(request);
    const windowSource = createWindowSourceStub({
      listWindows: (): WindowManagerState[] => [
        {
          windowId: 1,
          registrationId: REGISTRATION_ID_PROJECT,
          params: { projectId: 'project-1' },
          visible: true,
          focused: true,
        },
        {
          windowId: 2,
          registrationId: REGISTRATION_ID_CHAT,
          params: { sessionId: 'session-2' },
          visible: true,
          focused: false,
        },
        {
          windowId: 3,
          registrationId: REGISTRATION_ID_PROJECT,
          visible: false,
          focused: false,
        },
      ],
      getWindow: (windowId): Readonly<WindowSessionWindowEntry> | undefined => {
        if (windowId === 1) {
          return {
            registrationId: REGISTRATION_ID_PROJECT,
            params: { projectId: 'project-1' },
            win: {
              isDestroyed: () => false,
              getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
            },
          };
        }
        if (windowId === 2) {
          return {
            registrationId: REGISTRATION_ID_CHAT,
            params: { sessionId: 'session-2' },
            win: {
              isDestroyed: () => true,
              getBounds: () => ({ x: 0, y: 0, width: 500, height: 400 }),
            },
          };
        }
        return {
          registrationId: REGISTRATION_ID_PROJECT,
          win: {
            isDestroyed: () => false,
            getBounds: () => ({ x: 0, y: 0, width: 0, height: 400 }),
          },
        };
      },
    });

    await saveWindowSession(busClient, windowSource, HOST_SCOPE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(PreferencesSubjects.set, {
      key: { scope: HOST_SCOPE },
      category: 'window-session',
      value: {
        version: 1,
        windows: [
          {
            registrationId: REGISTRATION_ID_PROJECT,
            params: { projectId: 'project-1' },
            bounds: { x: 10, y: 20, width: 1200, height: 800 },
          },
        ],
      },
    });
  });

  it('omits undefined optional params from persisted window entries', async () => {
    const request = vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({ success: true });
    const busClient = createBusClientStub(request);
    const windowSource = createWindowSourceStub({
      listWindows: () => [
        {
          windowId: 1,
          registrationId: REGISTRATION_ID_PROJECT,
          visible: true,
          focused: true,
        },
      ],
      getWindow: () => ({
        registrationId: REGISTRATION_ID_PROJECT,
        win: {
          isDestroyed: () => false,
          getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
        },
      }),
    });

    await saveWindowSession(busClient, windowSource, HOST_SCOPE);

    expect(request).toHaveBeenCalledWith(PreferencesSubjects.set, {
      key: { scope: HOST_SCOPE },
      category: 'window-session',
      value: {
        version: 1,
        windows: [
          {
            registrationId: REGISTRATION_ID_PROJECT,
            bounds: { x: 10, y: 20, width: 1200, height: 800 },
          },
        ],
      },
    });
  });

  it('deletes the stored session when no windows are persistable', async () => {
    const request = vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({ success: true });
    const busClient = createBusClientStub(request);

    await saveWindowSession(busClient, createWindowSourceStub({ listWindows: () => [] }), HOST_SCOPE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(PreferencesSubjects.delete, {
      key: { scope: HOST_SCOPE },
      category: 'window-session',
    });
  });

  it('loads and validates a persisted session from the injected host scope', async () => {
    const request = vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({
      value: {
        version: 1,
        windows: [
          {
            registrationId: REGISTRATION_ID_CHAT,
            params: { sessionId: 'session-1' },
            bounds: { x: 5, y: 6, width: 700, height: 500 },
          },
        ],
      },
    });
    const busClient = createBusClientStub(request);

    await expect(loadWindowSession(busClient, HOST_SCOPE)).resolves.toEqual({
      version: 1,
      windows: [
        {
          registrationId: REGISTRATION_ID_CHAT,
          params: { sessionId: 'session-1' },
          bounds: { x: 5, y: 6, width: 700, height: 500 },
        },
      ],
    });

    expect(request).toHaveBeenCalledWith(PreferencesSubjects.get, {
      key: { scope: HOST_SCOPE },
      category: 'window-session',
    });
  });

  it('returns null when stored session data fails validation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const busClient = createBusClientStub(
      vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({
        value: {
          version: 1,
          windows: [{ type: 'project', bounds: { x: 1, y: 2, width: 800, height: 600 } }],
        },
      }),
    );

    await expect(loadWindowSession(busClient, HOST_SCOPE)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null when stored session has degenerate bounds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const busClient = createBusClientStub(
      vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({
        value: {
          version: 1,
          windows: [{ registrationId: REGISTRATION_ID_PROJECT, bounds: { x: 1, y: 2, width: 0, height: 400 } }],
        },
      }),
    );

    await expect(loadWindowSession(busClient, HOST_SCOPE)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null and logs a warning when the bus request throws during load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const busClient = createBusClientStub(vi.fn().mockRejectedValue(new Error('Transport disconnected')));

    await expect(loadWindowSession(busClient, HOST_SCOPE)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[WindowSession] Failed to load window session from preferences:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('lets bus errors propagate from saveWindowSession', async () => {
    const busClient = createBusClientStub(vi.fn().mockRejectedValue(new Error('Transport disconnected')));
    const windowSource = createWindowSourceStub({
      listWindows: () => [{ windowId: 1, registrationId: REGISTRATION_ID_PROJECT, visible: true, focused: true }],
      getWindow: () => ({
        registrationId: REGISTRATION_ID_PROJECT,
        win: { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
      }),
    });

    await expect(saveWindowSession(busClient, windowSource, HOST_SCOPE)).rejects.toThrow('Transport disconnected');
  });

  it('deletes the stored session when all windows are destroyed', async () => {
    const request = vi.fn<WindowSessionBusClient['request']>().mockResolvedValue({ success: true });
    const busClient = createBusClientStub(request);
    const windowSource = createWindowSourceStub({
      listWindows: () => [
        { windowId: 1, registrationId: REGISTRATION_ID_PROJECT, visible: true, focused: true },
        { windowId: 2, registrationId: REGISTRATION_ID_CHAT, visible: true, focused: false },
      ],
      getWindow: () => ({
        registrationId: REGISTRATION_ID_PROJECT,
        win: { isDestroyed: () => true, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
      }),
    });

    await saveWindowSession(busClient, windowSource, HOST_SCOPE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(PreferencesSubjects.delete, {
      key: { scope: HOST_SCOPE },
      category: 'window-session',
    });
  });
});
