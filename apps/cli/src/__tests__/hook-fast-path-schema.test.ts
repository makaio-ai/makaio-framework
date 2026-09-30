/**
 * Consistency tests between the light hook path argv detector and the Commander
 * schemas of `makaio hook received|handle`.
 *
 * The detector re-implements a subset of the Commander parsing by hand, so a
 * renamed, removed, or added option in `clientHooksCli` must break this test
 * instead of silently diverging the two paths. The schemas are read through the
 * public `clientHooksCli.subcommands` contribution (the schema constants are module-private).
 */
import { clientHooksCli } from '@makaio/extension-client-hooks';
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
 * Look up the schema of a `hook` subcommand, failing loudly when it is absent.
 * @param name - Subcommand name.
 * @returns The subcommand's Zod object schema.
 */
function schemaOf(name: 'received' | 'handle') {
  const entry = clientHooksCli.subcommands?.find((subcommand) => subcommand.name === name);
  if (entry === undefined) {
    throw new Error(`clientHooksCli has no "${name}" subcommand; the light hook path detector is out of sync`);
  }
  return entry.schema;
}

/** Detector fields that are root flags or the command selector, not schema fields. */
const NON_SCHEMA_FIELDS = new Set(['command', 'noLaunch', 'debounceFailure']);

/**
 * Project an invocation onto the schema-relevant values the detector extracted.
 * @param invocation - Detector result.
 * @returns Object holding only defined, schema-level values (as Commander would hand to the schema).
 */
function extractedValues(invocation: LightHookInvocation): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(invocation)) {
    if (NON_SCHEMA_FIELDS.has(key) || value === undefined) continue;
    // `received` has no --fail-close; the detector pins it to false there.
    if (invocation.command === 'received' && key === 'failClose') continue;
    values[key] = value;
  }
  return values;
}

/**
 * Parse argv that must be accepted by the detector.
 * @param input - Full argv.
 * @returns The detected invocation.
 */
function detect(input: string[]): LightHookInvocation {
  const invocation = parseLightHookInvocation(input);
  if (invocation === null) throw new Error(`detector unexpectedly rejected: ${input.join(' ')}`);
  return invocation;
}

describe('light hook detector vs Commander schemas: field sets', () => {
  it('received: schema keys equal the fields the detector can produce', () => {
    const produced = Object.keys(
      extractedValues(detect(argv('hook', 'received', 'codex', 'Stop', '--metadata-json', '{}'))),
    );
    expect(Object.keys(schemaOf('received').shape).sort()).toEqual(produced.sort());
  });

  it('handle: schema keys equal the fields the detector can produce', () => {
    const produced = Object.keys(
      extractedValues(
        detect(argv('hook', 'handle', 'codex', 'Stop', '--metadata-json', '{}', '--timeout', '5', '--fail-close')),
      ),
    );
    expect(Object.keys(schemaOf('handle').shape).sort()).toEqual(produced.sort());
  });
});

describe('light hook detector vs Commander schemas: accepted values', () => {
  const cases: Array<['received' | 'handle', string, string[]]> = [
    ['received', 'received minimal', argv('hook', 'received', 'codex', 'Stop')],
    [
      'received',
      'received with --metadata-json',
      argv('--debounce-failure', 'hook', 'received', 'claude-code', 'Stop', '--metadata-json', '{"pid":1}'),
    ],
    ['handle', 'handle minimal (timeout default applies)', argv('hook', 'handle', 'codex', 'Stop')],
    [
      'handle',
      'handle with timeout',
      argv('--no-launch', '--debounce-failure', 'hook', 'handle', 'claude-code', 'PreToolUse', '--timeout', '5000'),
    ],
    [
      'handle',
      'handle --fail-close and metadata',
      argv('hook', 'handle', 'codex', 'Stop', '--fail-close', '--metadata-json', '{"a":"b"}', '--timeout', '250'),
    ],
  ];

  it.each(cases)('%s: %s', (command, _name, input) => {
    const invocation = detect(input);
    expect(invocation.command).toBe(command);
    const values = extractedValues(invocation);
    const parsed = schemaOf(command).safeParse(values);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject(values);
    if (command === 'handle' && values['timeout'] === undefined) {
      // Timeout absent in argv: the schema default fills it in with a valid value.
      expect(parsed.data).toHaveProperty('timeout', expect.any(Number));
    }
    if (command === 'handle') expect(parsed.data).toHaveProperty('failClose', invocation.failClose);
  });
});

describe('light hook detector vs Commander schemas: timeout rule parity', () => {
  it.each([0, -1, 1.5])('schema and detector both reject --timeout %s', (timeout) => {
    const schema = schemaOf('handle');
    expect(schema.safeParse({ client: 'codex', eventName: 'Stop', timeout }).success).toBe(false);
    expect(parseLightHookInvocation(argv('hook', 'handle', 'codex', 'Stop', '--timeout', String(timeout)))).toBeNull();
  });

  it('schema and detector both accept a positive integer timeout', () => {
    const schema = schemaOf('handle');
    expect(schema.safeParse({ client: 'codex', eventName: 'Stop', timeout: 1 }).success).toBe(true);
    expect(parseLightHookInvocation(argv('hook', 'handle', 'codex', 'Stop', '--timeout', '1'))).not.toBeNull();
  });
});
