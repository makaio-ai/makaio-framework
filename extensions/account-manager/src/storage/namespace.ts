import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerStorageSchemas } from './schemas.js';

const AccountManagerStorageNamespace = MakaioBus.registerNamespace(
  'account-manager.storage',
  AccountManagerStorageSchemas,
);

/** Internal subjects for Drizzle-backed account-manager storage. */
export const AccountManagerStorageSubjects = AccountManagerStorageNamespace.subjects;
