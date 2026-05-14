/**
 * Local notification bus namespace definition.
 *
 * Import via `@makaio/services-core/local-notification/namespace` at your
 * application composition root and register the namespace explicitly.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import { LocalNotificationSchemas } from './schemas.js';

/**
 * Local notification namespace definition.
 *
 * Provides type-safe subjects for platform-native notification operations.
 * Each platform (Electron, iOS, Android, Web) registers a single provider
 * that handles these subjects.
 */
export const LocalNotificationNamespace = createBusNamespace('local-notification', LocalNotificationSchemas);

/**
 * Typed subjects for local notification operations.
 *
 * Subjects available:
 * - `LocalNotificationSubjects.notify` — Show a local notification (RPC)
 * - `LocalNotificationSubjects.getProvider` — Get provider info (RPC)
 */
export const LocalNotificationSubjects = LocalNotificationNamespace.subjects;
