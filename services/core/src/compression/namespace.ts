import { createBusNamespace } from '@makaio/core';
import { CompressionSchemas } from './schemas.js';

export const CompressionNamespace = createBusNamespace('compression', CompressionSchemas);

export const CompressionSubjects = CompressionNamespace.subjects;
