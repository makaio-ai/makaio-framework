import { createBusNamespace } from '@makaio/core';
import { SessionSchemas } from './schemas.js';

export const SessionNamespace = createBusNamespace('session', SessionSchemas);

export const SessionSubjects = SessionNamespace.subjects;
