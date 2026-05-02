import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSchemas } from './schemas.js';

/** Registered bus namespace for account-manager subjects. Importing this module triggers namespace registration as a side effect. */
export const AccountManagerNamespace = MakaioBus.registerNamespace('account-manager', AccountManagerSchemas);

/** Type-safe subject accessors for the `account-manager` namespace. */
export const AccountManagerSubjects = AccountManagerNamespace.subjects;
