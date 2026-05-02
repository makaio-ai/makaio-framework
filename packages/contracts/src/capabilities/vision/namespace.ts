import { MakaioBus } from '@makaio/bus-core';
import { VisionSchemas } from './schemas.js';

export const VisionNamespace = MakaioBus.registerNamespace('vision', VisionSchemas);
export const VisionSubjects = VisionNamespace.subjects;
