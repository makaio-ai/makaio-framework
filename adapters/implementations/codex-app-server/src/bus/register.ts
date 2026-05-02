/**
 * Notification domain has no bus subjects — types are UI-local state only.
 *
 * This module exists to satisfy the `./register` export convention used by
 * domain packages and to serve as a future extension point if notification
 * bus subjects are introduced.
 * @packageDocumentation
 */

export { NotificationKindSchema, NotificationUrgencySchema } from './schemas.js';
export type {
  AgentCompleteNotification,
  ApprovalNotification,
  NotificationBase,
  NotificationEntry,
  NotificationUrgency,
} from './schemas.js';
