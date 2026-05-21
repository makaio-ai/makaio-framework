import { createBusNamespace } from '@makaio/core';
import { VisionSchemas } from './schemas.js';

export const VisionNamespace = createBusNamespace('vision', VisionSchemas);
export const VisionSubjects = VisionNamespace.subjects;
