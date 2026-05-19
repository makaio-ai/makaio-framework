/**
 * Unit tests for {@link resolveHost} and {@link resolveAuth}.
 *
 * Both are pure functions (modulo `process.env` for `resolveAuth`) that
 * determine the bind address and bus authentication strategy for the CLI
 * serve command.  `resolveAuth` tests control `MAKAIO_BUS_SECRET` via
 * `process.env` and restore it in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchingAuth, HmacAuth } from '@makaio/bus-transport-websocket';
import { createRestartHandler, resolveAuth, resolveHost } from './serve.js';

const EMPTY_SECRET_ERROR = '[serve] MAKAIO_BUS_SECRET is set but empty; refusing to initialize HmacAuth';

// ---------------------------------------------------------------------------
// resolveHost
// ---------------------------------------------------------------------------

describe('resolveHost', () => {
  it('defaults to loopback when no options are provided', () => {
    expect(resolveHost({})).toBe('127.0.0.1');
  });

  it('respects an explicit --host value', () => {
    expect(resolveHost({ host: '192.168.1.5' })).toBe('192.168.1.5');
  });

  it('returns 0.0.0.0 when --lan-bind is set without --host', () => {
    expect(resolveHost({ lanBind: true })).toBe('0.0.0.0');
  });

  it('--host takes precedence over --lan-bind', () => {
    expect(resolveHost({ host: '192.168.1.5', lanBind: true })).toBe('192.168.1.5');
  });
});

describe('resolveAuth', () => {
  /** Original value of the env var, restored after every test. */
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env['MAKAIO_BUS_SECRET'];
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env['MAKAIO_BUS_SECRET'];
    } else {
      process.env['MAKAIO_BUS_SECRET'] = originalSecret;
    }
  });

  // ---------------------------------------------------------------------------
  // Loopback (lanBind = false)
  // ---------------------------------------------------------------------------

  describe('loopback mode (lanBind = false)', () => {
    it('returns undefined when no secret is set', () => {
      delete process.env['MAKAIO_BUS_SECRET'];

      const auth = resolveAuth(false);

      expect(auth).toBeUndefined();
    });

    it('returns an HmacAuth instance when a secret is provided', () => {
      process.env['MAKAIO_BUS_SECRET'] = 'my-loopback-secret';

      const auth = resolveAuth(false);

      expect(auth).toBeInstanceOf(HmacAuth);
    });

    it('returns an HmacAuth instance when the secret has surrounding whitespace', () => {
      // The implementation trims the value, so "  secret  " is a valid secret.
      process.env['MAKAIO_BUS_SECRET'] = '  trimmed-secret  ';

      const auth = resolveAuth(false);

      expect(auth).toBeInstanceOf(HmacAuth);
    });

    it('throws when the secret is an empty string', () => {
      process.env['MAKAIO_BUS_SECRET'] = '';

      expect(() => resolveAuth(false)).toThrow(EMPTY_SECRET_ERROR);
    });

    it('throws when the secret is whitespace-only', () => {
      // After trimming, "   " becomes "" — same rejection path as empty string.
      process.env['MAKAIO_BUS_SECRET'] = '   ';

      expect(() => resolveAuth(false)).toThrow(EMPTY_SECRET_ERROR);
    });
  });

  // ---------------------------------------------------------------------------
  // LAN mode (lanBind = true)
  // ---------------------------------------------------------------------------

  describe('LAN mode (lanBind = true)', () => {
    it('returns a DispatchingAuth instance when no secret is set', () => {
      delete process.env['MAKAIO_BUS_SECRET'];

      const auth = resolveAuth(true);

      expect(auth).toBeInstanceOf(DispatchingAuth);
    });

    it('returns a DispatchingAuth instance when a secret is provided', () => {
      process.env['MAKAIO_BUS_SECRET'] = 'my-lan-secret';

      const auth = resolveAuth(true);

      expect(auth).toBeInstanceOf(DispatchingAuth);
    });

    it('throws when the secret is an empty string', () => {
      process.env['MAKAIO_BUS_SECRET'] = '';

      expect(() => resolveAuth(true)).toThrow(EMPTY_SECRET_ERROR);
    });

    it('throws when the secret is whitespace-only', () => {
      process.env['MAKAIO_BUS_SECRET'] = '   ';

      expect(() => resolveAuth(true)).toThrow(EMPTY_SECRET_ERROR);
    });
  });

  // ---------------------------------------------------------------------------
  // Return-type contracts
  // ---------------------------------------------------------------------------

  describe('return-type contracts', () => {
    it('loopback with secret returns HmacAuth, not DispatchingAuth', () => {
      process.env['MAKAIO_BUS_SECRET'] = 'secret';

      const auth = resolveAuth(false);

      expect(auth).toBeInstanceOf(HmacAuth);
      expect(auth).not.toBeInstanceOf(DispatchingAuth);
    });

    it('LAN without secret returns DispatchingAuth, not HmacAuth', () => {
      delete process.env['MAKAIO_BUS_SECRET'];

      const auth = resolveAuth(true);

      expect(auth).toBeInstanceOf(DispatchingAuth);
      expect(auth).not.toBeInstanceOf(HmacAuth);
    });

    it('LAN with secret returns DispatchingAuth, not a bare HmacAuth', () => {
      process.env['MAKAIO_BUS_SECRET'] = 'secret';

      const auth = resolveAuth(true);

      expect(auth).toBeInstanceOf(DispatchingAuth);
      expect(auth).not.toBeInstanceOf(HmacAuth);
    });
  });
});

// ---------------------------------------------------------------------------
// createRestartHandler
// ---------------------------------------------------------------------------

describe('createRestartHandler', () => {
  it('sets accepted result and schedules shutdown', () => {
    const shutdownFn = vi.fn();
    const scheduledTasks: (() => void)[] = [];
    const handler = createRestartHandler({
      shutdown: shutdownFn,
      schedule: (task) => scheduledTasks.push(task),
    });

    const ctx = { setResult: vi.fn() };
    handler(ctx);

    expect(ctx.setResult).toHaveBeenCalledWith({ accepted: true });
    expect(shutdownFn).not.toHaveBeenCalled();

    // Execute the scheduled task
    scheduledTasks[0]!();
    expect(shutdownFn).toHaveBeenCalledOnce();
  });

  it('calls setResult before invoking scheduler', () => {
    const callOrder: string[] = [];
    const handler = createRestartHandler({
      shutdown: () => {
        callOrder.push('shutdown');
      },
      schedule: (task) => {
        callOrder.push('scheduled');
        task();
      },
    });

    handler({ setResult: () => callOrder.push('setResult') });

    expect(callOrder).toEqual(['setResult', 'scheduled', 'shutdown']);
  });

  it('defaults schedule to setTimeout when not provided', () => {
    // Verify the handler does not throw when schedule is omitted.
    const handler = createRestartHandler({ shutdown: vi.fn() });
    expect(() => handler({ setResult: vi.fn() })).not.toThrow();
  });

  it('schedules shutdown only once for duplicate restart requests', () => {
    const scheduledTasks: (() => void)[] = [];
    const handler = createRestartHandler({
      shutdown: vi.fn(),
      schedule: (task) => scheduledTasks.push(task),
    });

    handler({ setResult: vi.fn() });
    handler({ setResult: vi.fn() });

    expect(scheduledTasks).toHaveLength(1);
  });
});
