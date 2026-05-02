import { MakaioBus } from '@makaio/bus-core';
import { CompressionSchemas } from './schemas.js';

export const CompressionNamespace = MakaioBus.registerNamespace('compression', CompressionSchemas);

export const CompressionSubjects = CompressionNamespace.subjects;
