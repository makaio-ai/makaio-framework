/**
 * Unit tests for buildTurnInitiator.
 *
 * Pure function, no bus required.
 */
import { describe, it, expect } from 'vitest';
import { buildTurnInitiator } from '../turn-initiator.js';

describe('buildTurnInitiator', () => {
  it.each([
    { source: undefined, expected: { source: 'user' } },
    { source: 'user' as const, expected: { source: 'user' } },
    { source: 'system' as const, expected: { source: 'system' } },
  ])('returns the expected initiator for source=$source', ({ source, expected }) => {
    expect(buildTurnInitiator(source, undefined)).toEqual(expected);
    expect(buildTurnInitiator(source, 'some-extension')).toEqual(expected);
  });

  describe('source === "extension"', () => {
    it('returns extension initiator with sourceId when extensionId is provided', () => {
      expect(buildTurnInitiator('extension', 'routine:validation')).toEqual({
        source: 'extension',
        sourceId: 'routine:validation',
      });
    });

    it('trims whitespace from extensionId', () => {
      expect(buildTurnInitiator('extension', '  my-extension  ')).toEqual({
        source: 'extension',
        sourceId: 'my-extension',
      });
    });

    it.each([undefined, '', '   '])('throws when extensionId is invalid (%j)', (extensionId) => {
      expect(() => buildTurnInitiator('extension', extensionId)).toThrow(
        'extensionId is required when source is "extension"',
      );
    });
  });
});
