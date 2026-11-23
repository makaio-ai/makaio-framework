import { describe, expect, it } from 'vitest';
import { attestationForRole } from '../index.js';

describe('attestationForRole', () => {
  it.each([
    ['core-uplink', 'outbound'],
    ['job-run', 'inbound'],
    ['local-cli', 'inbound'],
  ])('resolves %s to %s', (role, direction) => {
    expect(attestationForRole(role)).toBe(direction);
  });

  it.each(['toString', 'constructor', '__proto__', 'unknown-role'])('grants no attestation to %s', (role) => {
    expect(attestationForRole(role)).toBeUndefined();
  });
});
