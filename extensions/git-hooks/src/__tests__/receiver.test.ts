import { describe, expect, it, vi } from 'vitest';
import { parseReceiverArgs } from '../receiver/args.js';
import { receiveGitHook } from '../receiver/receive.js';
import type { RawInboundHookPayload } from '@makaio/inbound-hooks';

describe('parseReceiverArgs', () => {
  it('parses event, state, and forwarded hook argv', () => {
    expect(
      parseReceiverArgs([
        '--event',
        'post-checkout',
        '--state',
        '/repo/.git/hooks/.makaio-hooks.json',
        '--',
        'a',
        'b',
        '1',
      ]),
    ).toEqual({
      eventName: 'post-checkout',
      stateFile: '/repo/.git/hooks/.makaio-hooks.json',
      argv: ['a', 'b', '1'],
    });
  });

  it('parses event and state with no hook argv when separator is absent', () => {
    expect(parseReceiverArgs(['--event', 'post-commit', '--state', '/repo/.git/hooks/.makaio-hooks.json'])).toEqual({
      eventName: 'post-commit',
      stateFile: '/repo/.git/hooks/.makaio-hooks.json',
      argv: [],
    });
  });

  it('throws when --event is missing', () => {
    expect(() => parseReceiverArgs(['--state', '/repo/.git/hooks/.makaio-hooks.json'])).toThrow(
      '[git-hook-receiver] Missing --event',
    );
  });

  it('throws when --state is missing', () => {
    expect(() => parseReceiverArgs(['--event', 'post-commit'])).toThrow('[git-hook-receiver] Missing --state');
  });
});

describe('receiveGitHook', () => {
  it('emits a raw git hook payload with repo context', async () => {
    const emit = vi.fn(async (_source: string, _payload: RawInboundHookPayload) => undefined);

    await receiveGitHook(
      {
        eventName: 'post-commit',
        stateFile: '/repo/.git/hooks/.makaio-hooks.json',
        argv: [],
      },
      {
        cwd: '/repo',
        readStdinText: async () => '',
        emit,
        now: () => 10,
      },
    );

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      'git',
      expect.objectContaining({
        eventName: 'post-commit',
        receivedAt: 10,
        argv: [],
        stdinText: '',
      }),
    );
  });

  it('includes repo context in the payload field', async () => {
    const emit = vi.fn(async (_source: string, _payload: RawInboundHookPayload) => undefined);

    await receiveGitHook(
      {
        eventName: 'post-checkout',
        stateFile: '/repo/.git/hooks/.makaio-hooks.json',
        argv: ['HEAD~1', 'HEAD', '1'],
      },
      {
        cwd: '/repo',
        readStdinText: async () => '',
        emit,
        now: () => 42,
      },
    );

    const [, emittedPayload] = emit.mock.calls[0] as [string, RawInboundHookPayload];
    expect(emittedPayload.payload).toMatchObject({
      cwd: '/repo',
    });
    expect(emittedPayload.argv).toEqual(['HEAD~1', 'HEAD', '1']);
  });

  it('forwards stdin text in the emitted payload', async () => {
    const emit = vi.fn(async (_source: string, _payload: RawInboundHookPayload) => undefined);

    await receiveGitHook(
      { eventName: 'post-rewrite', stateFile: '/repo/.git/hooks/.makaio-hooks.json', argv: ['amend'] },
      {
        cwd: '/repo',
        readStdinText: async () => 'abc def\nghi jkl\n',
        emit,
        now: () => 1,
      },
    );

    expect(emit).toHaveBeenCalledWith('git', expect.objectContaining({ stdinText: 'abc def\nghi jkl\n' }));
  });
});
