/**
 * Notification types and Zod schemas for the in-app notification center.
 *
 * Notification entries are UI-local state (not bus-transported RPCs), but
 * schemas are provided for consistency and future validation needs.
 * @packageDocumentation
 */

import type { RiskLevel } from '@makaio/contracts';
import { z } from 'zod';

/** Zod schema for {@link NotificationUrgency}. */
export const NotificationUrgencySchema = z.enum(['critical', 'high', 'normal', 'low']);

/** Zod schema for notification kind discriminator. */
export const NotificationKindSchema = z.enum(['approval', 'agent-complete']);

/**
 * Urgency level for a notification entry.
 * Controls sort order and visual treatment in the notification center.
 */
export type NotificationUrgency = z.infer<typeof NotificationUrgencySchema>;

/**
 * Base shape shared by all notification entries.
 */
export interface NotificationBase<TKind extends string = string> {
  /** Unique notification identifier */
  readonly id: string;
  /** Discriminator for the notification kind */
  readonly kind: TKind;
  /** Unix timestamp (ms) when the notification was created */
  readonly createdAt: number;
  /** How urgent the notification is (controls sort order) */
  readonly urgency: NotificationUrgency;
  /** Whether the user has seen/acknowledged this notification */
  readonly isRead: boolean;
  /** Session the notification is associated with (if any) */
  readonly sessionId?: string;
  /** Agent the notification is associated with (if any) */
  readonly agentId?: string;
  /** Human-readable label for the notification source */
  readonly sourceLabel: string;
}

/**
 * Notification for a pending tool approval request.
 * Derived from the approval queue — not stored independently.
 */
export interface ApprovalNotification extends NotificationBase<'approval'> {
  /** Discriminator: approval notification */
  readonly kind: 'approval';
  /** Session associated with this approval request */
  readonly sessionId: string;
  /** FK to the approval queue entry's requestId */
  readonly requestId: string;
  /** Tool call identifier */
  readonly toolCallId: string;
  /** Name of the tool awaiting approval */
  readonly toolName?: string;
  /** Risk classification for this tool call */
  readonly riskLevel?: RiskLevel;
}

/**
 * Notification for agent completion.
 * Emitted when an `agent.complete` bus event is received with a `sessionId`.
 */
export interface AgentCompleteNotification extends NotificationBase<'agent-complete'> {
  /** Discriminator: agent-complete notification */
  readonly kind: 'agent-complete';
  /** Summary of what the agent accomplished */
  readonly summary?: string;
}

/**
 * Discriminated union of all notification entry types.
 * Extend this union to add new notification kinds.
 */
export type NotificationEntry = ApprovalNotification | AgentCompleteNotification;
