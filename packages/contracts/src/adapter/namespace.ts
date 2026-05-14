import { createBusNamespace } from '@makaio/core';
import { AdapterSchemas } from './schemas.js';

export const AdapterNamespace = createBusNamespace('adapter', AdapterSchemas);

export const AdapterSubjects = AdapterNamespace.subjects;
