import { describe, expect, it } from 'vitest';
import { SESSION_CLIENT_ACCOUNT_LINKING_PACKAGE_NAME, sessionClientAccountLinkingPackage } from '../package.js';

describe('sessionClientAccountLinkingPackage', () => {
  it('declares an explicit dependency on session storage', () => {
    expect(sessionClientAccountLinkingPackage).toMatchObject({
      name: SESSION_CLIENT_ACCOUNT_LINKING_PACKAGE_NAME,
      dependencies: ['session-storage', 'makaio.clients-core'],
    });
  });
});
