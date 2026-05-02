import { MakaioBus } from '@makaio/bus-core';

import { LogImportSchemas } from './schemas.js';

export const LogImportNamespace = MakaioBus.registerNamespace('log-import', LogImportSchemas);

export const LogImportSubjects = LogImportNamespace.subjects;
