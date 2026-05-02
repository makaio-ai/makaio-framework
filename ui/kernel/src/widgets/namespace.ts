import { MakaioBus } from '@makaio/bus-core';
import { WidgetSchemas } from './schemas.js';

export const WidgetNamespace = MakaioBus.registerNamespace('widget', WidgetSchemas);
export const WidgetSubjects = WidgetNamespace.subjects;
