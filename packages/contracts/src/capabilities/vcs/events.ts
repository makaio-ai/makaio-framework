/**
 * VCS comment mutation events for cache invalidation.
 *
 * Emitted after successful write operations. Subscribers use these events
 * to trigger automatic cache refreshes in UI components.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';

/**
 * VCS events namespace for cache invalidation.
 *
 * These events are emitted after successful PR comment mutations
 * (create, reply, resolve) to notify subscribers that cached data
 * should be refreshed.
 */
export const VCSEventsNamespace = MakaioBus.registerNamespace('vcs:events', {
  /**
   * Emitted after a comment is created or replied to.
   *
   * Subject: `vcs:events.comment.created`
   * Type: Event
   */
  'comment.created': z.object({
    /** Repository path */
    repoPath: z.string(),
    /** PR number */
    prNumber: z.number(),
    /** Created comment ID */
    commentId: z.number(),
  }),

  /**
   * Emitted after a thread is resolved.
   *
   * Subject: `vcs:events.thread.resolved`
   * Type: Event
   */
  'thread.resolved': z.object({
    /** Repository path */
    repoPath: z.string(),
    /** PR number */
    prNumber: z.number(),
    /** Thread ID (GraphQL node ID) */
    threadId: z.string(),
  }),
});

/**
 * Type-safe subjects for VCS events.
 *
 * Use these subjects with bus.emit() to trigger cache invalidation,
 * or with bus.on() to subscribe to cache invalidation events.
 */
export const VCSEvents = VCSEventsNamespace.subjects;
