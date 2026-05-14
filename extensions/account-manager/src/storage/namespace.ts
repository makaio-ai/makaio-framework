import { createExtensionStorageNamespace } from '@makaio/storage-core';
import { AccountManagerStorageSchemas } from './schemas.js';

const AccountManagerStorageNamespace = createExtensionStorageNamespace('account-manager', {
  schemas: AccountManagerStorageSchemas,
});

/** Internal subjects for Drizzle-backed account-manager storage. */
export const AccountManagerStorageSubjects = AccountManagerStorageNamespace.subjects;
