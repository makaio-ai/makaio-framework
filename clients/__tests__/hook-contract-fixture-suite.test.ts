/** @packageDocumentation */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isScenarioFixture } from './hook-contract-fixture-suite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const codexProbeFixturePath = resolve(
  __dirname,
  '..',
  'codex',
  'src',
  'runtime',
  '__tests__',
  'fixtures',
  'hook-contracts',
  'probe',
  'pre-tool-use-input-update.json',
);

describe('isScenarioFixture', () => {
  it('rejects a committed fixture when a required recorded-event field is removed', () => {
    const fixture: unknown = JSON.parse(readFileSync(codexProbeFixturePath, 'utf8'));
    expect(isScenarioFixture(fixture)).toBe(true);
    if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
      throw new TypeError('Expected committed probe fixture to be an object');
    }
    const corrupt = structuredClone(fixture) as Record<string, unknown>;
    const events = corrupt.events;
    if (!Array.isArray(events) || events.length !== 1 || typeof events[0] !== 'object' || events[0] === null) {
      throw new TypeError('Expected one object event in committed probe fixture');
    }
    delete (events[0] as Record<string, unknown>).sentinelInjected;
    expect(isScenarioFixture(corrupt)).toBe(false);
  });
});
