import { describe, expect, it } from 'bun:test';
import { displayLabel, displayMeta, formatIdentityLabel } from '../utils/format-account-display.js';
import { getUsageAuthPendingDisplayText } from '../utils/usage-auth-state.js';

describe('format-account-display', () => {
  it('falls back to a stable id prefix when no label is present', () => {
    expect(displayLabel({ id: '12345678-1234-5678-1234-567812345678' })).toBe('12345678');
  });

  it('includes a re-auth note when usage metadata requires re-authentication', () => {
    expect(
      displayMeta({
        authMode: 'chatgpt',
        planType: 'plus',
        usageAuthState: 'reauth-required',
      }),
    ).toBe('chatgpt, plus, reauth required');
  });

  it('omits the re-auth note when no persisted usage-auth marker exists', () => {
    expect(
      displayMeta({
        authMode: 'chatgpt',
      }),
    ).toBe('chatgpt');
  });

  it('shows a pending note before any usage snapshot has loaded', () => {
    expect(getUsageAuthPendingDisplayText({ authMode: 'chatgpt' }, true)).toBe('reauth pending');
  });

  it('omits the pending note after usage loads or when re-auth is already required', () => {
    expect(getUsageAuthPendingDisplayText({ authMode: 'chatgpt' }, false)).toBeNull();
    expect(getUsageAuthPendingDisplayText({ usageAuthState: 'reauth-required' }, true)).toBeNull();
  });
});

describe('formatIdentityLabel', () => {
  it('returns "name (email)" when both are non-empty', () => {
    expect(formatIdentityLabel('Alice', 'alice@example.com')).toBe('Alice (alice@example.com)');
  });

  it('returns name alone when email is null', () => {
    expect(formatIdentityLabel('Alice', null)).toBe('Alice');
  });

  it('returns email alone when name is null', () => {
    expect(formatIdentityLabel(null, 'alice@example.com')).toBe('alice@example.com');
  });

  it('returns null when both are null', () => {
    expect(formatIdentityLabel(null, null)).toBeNull();
  });

  it('treats whitespace-only name as absent', () => {
    expect(formatIdentityLabel('   ', 'alice@example.com')).toBe('alice@example.com');
  });

  it('treats whitespace-only email as absent', () => {
    expect(formatIdentityLabel('Alice', '   ')).toBe('Alice');
  });

  it('returns null when both are whitespace-only', () => {
    expect(formatIdentityLabel('   ', '   ')).toBeNull();
  });

  it('trims leading and trailing whitespace from name and email', () => {
    expect(formatIdentityLabel('  Alice  ', '  alice@example.com  ')).toBe('Alice (alice@example.com)');
  });
});
