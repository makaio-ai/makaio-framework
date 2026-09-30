/**
 * Unit tests for the light hook path argv detector.
 *
 * The accepted argv shapes are literal copies of what the client wiring writes
 * into native settings (the wiring packages are not imported to keep this test
 * dependency-free):
 * - Claude Code: `framework/clients/claude-code/src/runtime/wiring.ts` (header doc, request/event commands)
 * - Codex: `framework/clients/codex/src/runtime/wiring.ts` (`buildModeCommand`)
 *
 * The Commander schema consistency check lives in `hook-fast-path-schema.test.ts`,
 * which reads the schemas through `clientHooksCli.subcommands`.
 */
import { describe, expect, it } from 'vitest';
import { parseLightHookInvocation, type LightHookInvocation } from '../hook-fast-path-detect.js';

/** Prefix for `process.argv` (runtime + script). */
const RUNTIME: readonly string[] = ['node', 'makaio'];

/**
 * Build a full argv from the tail.
 * @param tail - Arguments after runtime and script.
 * @returns Full argv.
 */
function argv(...tail: string[]): string[] {
  return [...RUNTIME, ...tail];
}

/**
 * Build the expected invocation with defaults.
 * @param overrides - Fields differing from the defaults; the positionals are required.
 * @returns The full expected invocation.
 */
function expected(
  overrides: Partial<LightHookInvocation> & Pick<LightHookInvocation, 'command' | 'client' | 'eventName'>,
): LightHookInvocation {
  return {
    metadataJson: undefined,
    timeout: undefined,
    failClose: false,
    noLaunch: false,
    debounceFailure: false,
    ...overrides,
  };
}

describe('parseLightHookInvocation: accepted shapes', () => {
  const cases: Array<[string, string[], LightHookInvocation]> = [
    [
      'claude-code blockable handle (5000)',
      argv('--no-launch', '--debounce-failure', 'hook', 'handle', 'claude-code', 'PreToolUse', '--timeout', '5000'),
      expected({
        command: 'handle',
        client: 'claude-code',
        eventName: 'PreToolUse',
        timeout: 5000,
        noLaunch: true,
        debounceFailure: true,
      }),
    ],
    [
      'claude-code context-only handle (1000)',
      argv(
        '--no-launch',
        '--debounce-failure',
        'hook',
        'handle',
        'claude-code',
        'UserPromptSubmit',
        '--timeout',
        '1000',
      ),
      expected({
        command: 'handle',
        client: 'claude-code',
        eventName: 'UserPromptSubmit',
        timeout: 1000,
        noLaunch: true,
        debounceFailure: true,
      }),
    ],
    [
      'claude-code received',
      argv('--debounce-failure', 'hook', 'received', 'claude-code', 'Stop'),
      expected({ command: 'received', client: 'claude-code', eventName: 'Stop', debounceFailure: true }),
    ],
    [
      'codex handle (5000)',
      argv('--no-launch', '--debounce-failure', 'hook', 'handle', 'codex', 'PermissionRequest', '--timeout', '5000'),
      expected({
        command: 'handle',
        client: 'codex',
        eventName: 'PermissionRequest',
        timeout: 5000,
        noLaunch: true,
        debounceFailure: true,
      }),
    ],
    [
      'codex handle (1000)',
      argv('--no-launch', '--debounce-failure', 'hook', 'handle', 'codex', 'UserPromptSubmit', '--timeout', '1000'),
      expected({
        command: 'handle',
        client: 'codex',
        eventName: 'UserPromptSubmit',
        timeout: 1000,
        noLaunch: true,
        debounceFailure: true,
      }),
    ],
    [
      'codex received',
      argv('--debounce-failure', 'hook', 'received', 'codex', 'Stop'),
      expected({ command: 'received', client: 'codex', eventName: 'Stop', debounceFailure: true }),
    ],
    [
      'no root flags, received',
      argv('hook', 'received', 'codex', 'Stop'),
      expected({ command: 'received', client: 'codex', eventName: 'Stop' }),
    ],
    [
      'root flags in reverse order',
      argv('--debounce-failure', '--no-launch', 'hook', 'handle', 'codex', 'Stop'),
      expected({ command: 'handle', client: 'codex', eventName: 'Stop', noLaunch: true, debounceFailure: true }),
    ],
    [
      'handle --fail-close, options in any order',
      argv('hook', 'handle', 'codex', 'Stop', '--fail-close', '--timeout', '250'),
      expected({ command: 'handle', client: 'codex', eventName: 'Stop', failClose: true, timeout: 250 }),
    ],
    [
      'received with --metadata-json',
      argv('hook', 'received', 'codex', 'Stop', '--metadata-json', '{"pid":1}'),
      expected({ command: 'received', client: 'codex', eventName: 'Stop', metadataJson: '{"pid":1}' }),
    ],
    [
      'handle with --metadata-json and --timeout',
      argv('hook', 'handle', 'codex', 'Stop', '--metadata-json', '{"a":"b"}', '--timeout', '7'),
      expected({ command: 'handle', client: 'codex', eventName: 'Stop', metadataJson: '{"a":"b"}', timeout: 7 }),
    ],
  ];

  it.each(cases)('%s', (_name, input, want) => {
    expect(parseLightHookInvocation(input)).toEqual(want);
  });
});

describe('parseLightHookInvocation: rejected shapes', () => {
  const handle = ['hook', 'handle', 'codex', 'Stop'];
  const received = ['hook', 'received', 'codex', 'Stop'];

  const cases: Array<[string, string[]]> = [
    // help
    ['--help before hook', argv('--help', ...handle)],
    ['-h before hook', argv('-h', ...handle)],
    ['--help after operands', argv(...handle, '--help')],
    ['-h after operands', argv(...received, '-h')],
    ['--help among options', argv(...handle, '--timeout', '5', '--help')],
    // root flags not supported
    ['--config root flag', argv('--config', 'x', ...handle)],
    ['--no-failure root flag', argv('--no-failure', ...handle)],
    ['unknown root flag', argv('--verbose', ...handle)],
    ['unknown option', argv(...handle, '--bogus')],
    ['unknown option with value', argv(...received, '--bogus', 'x')],
    // timeout validity
    ['--timeout=5', argv(...handle, '--timeout=5')],
    ['--timeout 0', argv(...handle, '--timeout', '0')],
    ['--timeout -1', argv(...handle, '--timeout', '-1')],
    ['--timeout 1.5', argv(...handle, '--timeout', '1.5')],
    ['--timeout 1e3', argv(...handle, '--timeout', '1e3')],
    ['--timeout 05', argv(...handle, '--timeout', '05')],
    ['--timeout +5', argv(...handle, '--timeout', '+5')],
    ['--timeout non-numeric', argv(...handle, '--timeout', 'abc')],
    ['--timeout empty', argv(...handle, '--timeout', '')],
    ['--timeout missing value', argv(...handle, '--timeout')],
    ['--timeout unsafe integer', argv(...handle, '--timeout', '99999999999999999999')],
    // handle-only options on received
    ['--fail-close on received', argv(...received, '--fail-close')],
    ['--timeout on received', argv(...received, '--timeout', '5')],
    // other spellings
    ['--metadata-json=x', argv(...received, '--metadata-json={}')],
    ['--metadata-json missing value', argv(...received, '--metadata-json')],
    ['--metadata-json flag-looking value', argv(...received, '--metadata-json', '--timeout')],
    ['--metadata-json empty value', argv(...received, '--metadata-json', '')],
    // repeats
    ['repeated --timeout', argv(...handle, '--timeout', '5', '--timeout', '6')],
    ['repeated --fail-close', argv(...handle, '--fail-close', '--fail-close')],
    ['repeated --metadata-json', argv(...received, '--metadata-json', '{}', '--metadata-json', '{}')],
    ['repeated --no-launch', argv('--no-launch', '--no-launch', ...handle)],
    ['repeated --debounce-failure', argv('--debounce-failure', '--debounce-failure', ...handle)],
    // positionals
    ['missing event name', argv('hook', 'handle', 'codex')],
    ['missing client and event', argv('hook', 'received')],
    ['extra positional', argv(...received, 'extra')],
    ['extra positional after options', argv(...handle, '--timeout', '5', 'extra')],
    ['empty client', argv('hook', 'received', '', 'Stop')],
    ['empty event name', argv('hook', 'received', 'codex', '')],
    ['flag-looking client', argv('hook', 'received', '--x', 'Stop')],
    ['flag-looking event name', argv('hook', 'received', 'codex', '-x')],
    // other commands
    ['bare hook', argv('hook')],
    ['hook unknown subcommand', argv('hook', 'foo', 'codex', 'Stop')],
    ['serve', argv('serve')],
    ['root flags only', argv('--no-launch', '--debounce-failure')],
    ['no args', argv()],
    ['root flag after hook', argv('hook', '--no-launch', 'received', 'codex', 'Stop')],
    ['leading positional before hook', argv('serve', ...received)],
  ];

  it.each(cases)('%s', (_name, input) => {
    expect(parseLightHookInvocation(input)).toBeNull();
  });
});
