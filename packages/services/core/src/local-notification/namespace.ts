/**
 * Local notification bus namespace registration.
 *
 * Importing this module registers the `local-notification` namespace on the bus
 * as a side effect. Import via `@makaio/services-core/local-notification/namespace`
 * at your application composition root.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import { LocalNotificationSchemas } from './schemas.js';

/**
 * Local notification namespace registration.
 *
 * Provides type-safe subjects for platform-native notification operations.
 * Each platform (Electron, iOS, Android, Web) registers a single provider
 * that handles these subjects.
 */
export const LocalNotificationNamespace = MakaioBus.registerNamespace('local-notification', LocalNotificationSchemas);

/**
 * Typed subjects for local notification operations.
 *
 * Subjects available:
 * - `LocalNotificationSubjects.notify` — Show a local notification (RPC)
 * - `LocalNotificationSubjects.getProvider` — Get provider info (RPC)
 */
export const LocalNotificationSubjects = LocalNotificationNamespace.subjects;
