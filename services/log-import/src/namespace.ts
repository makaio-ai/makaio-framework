import { createBusNamespace } from '@makaio/core';

import { LogImportSchemas } from './schemas.js';

export const LogImportNamespace = createBusNamespace('log-import', LogImportSchemas);

export const LogImportSubjects = LogImportNamespace.subjects;
