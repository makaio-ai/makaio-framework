import { createBusNamespace } from '@makaio/core';
import { WidgetSchemas } from './schemas.js';

export const WidgetNamespace = createBusNamespace('widget', WidgetSchemas);
export const WidgetSubjects = WidgetNamespace.subjects;
