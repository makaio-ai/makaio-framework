import { MakaioBus } from '@makaio/bus-core';
import { SessionSchemas } from './schemas.js';

export const SessionNamespace = MakaioBus.registerNamespace('session', SessionSchemas);

export const SessionSubjects = SessionNamespace.subjects;
