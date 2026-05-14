import { createBusNamespace } from '@makaio/core';
import { AccountManagerSchemas } from './schemas.js';

/** Pure bus namespace definition for account-manager subjects. */
export const AccountManagerNamespace = createBusNamespace('extension:account-manager', AccountManagerSchemas);

/** Type-safe subject accessors for the `account-manager` namespace. */
export const AccountManagerSubjects = AccountManagerNamespace.subjects;
