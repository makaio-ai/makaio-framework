import { MakaioBus } from '@makaio/bus-core';
import { AdapterSchemas } from './schemas.js';

export const AdapterNamespace = MakaioBus.registerNamespace('adapter', AdapterSchemas);

export const AdapterSubjects = AdapterNamespace.subjects;
