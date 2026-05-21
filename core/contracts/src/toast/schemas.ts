/**
 * Toast bus schemas — pure Zod, no side effects.
 *
 * Defines Zod schemas for toast notification bus subjects.
 * Import this module when you only need types or validation shapes without
 * registering the namespace on the bus. To register the namespace, import
 * `./namespace` instead.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Toast notification levels.
 * Defines the severity/priority of a toast notification.
 */
export const ToastLevelSchema = z.enum(['success', 'info', 'warning', 'error']);

/**
 * Toast action button schema.
 * Defines an interactive action button that can be attached to a toast.
 */
export const ToastActionSchema = z.object({
  /** Unique identifier for this action */
  id: z.string(),
  /** Display label for the action button */
  label: z.string(),
  /** Visual variant of the action button */
  variant: z.enum(['default', 'destructive', 'outline']).optional(),
});

/**
 * Toast notification payload schema.
 * Defines the structure for showing a toast notification.
 */
export const ToastPayloadSchema = z
  .object({
    /** Severity level of the toast */
    level: ToastLevelSchema,
    /** Main message content to display */
    message: z.string(),
    /** Optional title/headline for the toast */
    title: z.string().optional(),
    /** Duration in milliseconds to show the toast (null = manual dismiss) */
    durationMs: z.number().nullable().optional(),
    /** Optional action buttons attached to the toast */
    actions: z.array(ToastActionSchema).optional(),
    /** Optional unique identifier for the toast instance */
    toastId: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.actions && value.actions.length > 0 && !value.toastId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'toastId is required when actions are provided',
        path: ['toastId'],
      });
    }
  });

/** Inferred TypeScript type for toast payload */
export type ToastPayload = z.infer<typeof ToastPayloadSchema>;

/** Inferred TypeScript type for toast action */
export type ToastAction = z.infer<typeof ToastActionSchema>;

/** Inferred TypeScript type for toast level */
export type ToastLevel = z.infer<typeof ToastLevelSchema>;

/**
 * Toast domain bus schemas aggregate.
 *
 * Each key becomes a subject identifier as `toast.<key>`.
 */
export const ToastSchemas = {
  /**
   * Show a toast notification.
   * Event: Fire-and-forget broadcast to display a toast.
   */
  show: ToastPayloadSchema,

  /**
   * Dismiss a toast notification programmatically.
   * Event: Fire-and-forget broadcast to close a specific toast.
   */
  dismiss: z.object({ toastId: z.string() }),

  /**
   * User interacted with a toast action button.
   * Event: Fired when user clicks an action button on a toast.
   */
  interacted: z.object({
    toastId: z.string(),
    actionId: z.string(),
    timestamp: z.number(),
  }),

  /**
   * Toast was dismissed (either by user or timeout).
   * Event: Fired when a toast is closed/dismissed.
   */
  dismissed: z.object({
    toastId: z.string(),
    timestamp: z.number(),
  }),
} satisfies SchemaRecord;
