import { describe, expect, it } from 'vitest';
import {
  USAGE_AUTH_CODE_AUTH_INVALID,
  USAGE_AUTH_CODE_TRANSIENT,
  buildUsageAuthClearMetadata,
  buildUsageAuthInvalidMetadata,
  isTransientReauthMarker,
} from '../utils/usage-auth-state.js';

describe('usage auth state metadata', () => {
  it('marks invalid usage auth with a structured auth-invalid code by default', () => {
    expect(buildUsageAuthInvalidMetadata('fp', 'expired token', 123)).toMatchObject({
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp',
      usageAuthMessage: 'expired token',
      usageAuthCode: USAGE_AUTH_CODE_AUTH_INVALID,
      usageAuthDetectedAt: 123,
    });
  });

  it('detects transient reauth markers from the structured code only', () => {
    expect(
      isTransientReauthMarker({
        usageAuthState: 'reauth-required',
        usageAuthMessage: '3 consecutive transient usage-fetch failures',
        usageAuthCode: USAGE_AUTH_CODE_TRANSIENT,
      }),
    ).toBe(true);

    expect(
      isTransientReauthMarker({
        usageAuthState: 'reauth-required',
        usageAuthMessage: 'this hard auth failure message mentions transient but is not retryable',
        usageAuthCode: USAGE_AUTH_CODE_AUTH_INVALID,
      }),
    ).toBe(false);
  });

  it('clears the structured marker with the rest of the usage-auth overlay', () => {
    expect(
      buildUsageAuthClearMetadata({
        usageAuthState: 'reauth-required',
        usageAuthCode: USAGE_AUTH_CODE_TRANSIENT,
      }),
    ).toMatchObject({
      usageAuthState: null,
      usageAuthFingerprint: null,
      usageAuthMessage: null,
      usageAuthCode: null,
      usageAuthDetectedAt: null,
    });
  });
});
