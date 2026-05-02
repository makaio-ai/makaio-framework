import { MakaioBus } from '@makaio/bus-core';
import { TrayMenuSchemas } from './schemas.js';

/** Registered namespace for tray menu registration, listing, and click events. */
export const TrayMenuNamespace = MakaioBus.registerNamespace('host:tray', TrayMenuSchemas);

/** Typed subjects for the host tray namespace. */
export const TrayMenuSubjects = TrayMenuNamespace.subjects;
