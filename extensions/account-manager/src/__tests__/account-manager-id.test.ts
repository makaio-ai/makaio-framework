import { describe, expect, it } from 'vitest';
import { ACCOUNT_MANAGER_ID } from '@makaio/extension-account-manager/constants';

describe('account-manager public identity', () => {
  it('exposes the normalized manager ID through the browser-safe constants entrypoint', () => {
    expect(ACCOUNT_MANAGER_ID).toBe('account-manager');
  });
});
