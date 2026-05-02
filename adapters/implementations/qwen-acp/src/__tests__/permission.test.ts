/**
 * Tests for mapApprovalToAcpResponse
 *
 * Verifies that Makaio allow/deny approval actions are mapped to the correct
 * ACP RequestPermissionResponse, with correct option-kind preference order
 * and cancelled fallback when no matching option exists.
 */

import { describe, it, expect } from 'vitest';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { mapApprovalToAcpResponse } from '../permission.js';

/**
 * Build a minimal PermissionOption for use in tests.
 * @param optionId - Unique identifier for the option
 * @param kind - Permission option kind
 * @returns A valid PermissionOption
 */
function makeOption(optionId: string, kind: PermissionOption['kind']): PermissionOption {
  return { optionId, kind, name: `Option ${optionId}` };
}

describe('mapApprovalToAcpResponse', () => {
  describe('allow action', () => {
    it('selects the allow_once option by preference when present', () => {
      const options: PermissionOption[] = [
        makeOption('opt-always', 'allow_always'),
        makeOption('opt-once', 'allow_once'),
      ];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    });

    it('falls back to allow_always when allow_once is absent', () => {
      const options: PermissionOption[] = [makeOption('opt-always', 'allow_always')];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-always' } });
    });

    it('returns cancelled when no allow-prefixed option exists', () => {
      const options: PermissionOption[] = [makeOption('opt-reject', 'reject_once')];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  describe('deny action', () => {
    it('selects the reject_once option by preference when present', () => {
      const options: PermissionOption[] = [
        makeOption('opt-always', 'reject_always'),
        makeOption('opt-once', 'reject_once'),
      ];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    });

    it('falls back to reject_always when reject_once is absent', () => {
      const options: PermissionOption[] = [makeOption('opt-always', 'reject_always')];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-always' } });
    });

    it('returns cancelled when no reject-prefixed option exists', () => {
      const options: PermissionOption[] = [makeOption('opt-allow', 'allow_once')];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  it('returns cancelled when the options array is empty', () => {
    expect(mapApprovalToAcpResponse('allow', [])).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(mapApprovalToAcpResponse('deny', [])).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
