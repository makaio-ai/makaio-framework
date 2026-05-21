/**
 * Toast namespace definition.
 *
 * Import `./schemas` when only pure Zod schemas are needed. Composition roots
 * register this namespace explicitly.
 * @example
 * ```typescript
 * // Show a toast
 * await MakaioBus.emit(ToastSubjects.show, {
 *   level: 'success',
 *   message: 'File saved successfully',
 *   title: 'Success',
 * });
 *
 * // Dismiss a toast
 * await MakaioBus.emit(ToastSubjects.dismiss, {
 *   toastId: 'toast-123',
 * });
 *
 * // Handle user interaction with toast action
 * MakaioBus.on(ToastSubjects.interacted, (ctx) => {
 *   const { toastId, actionId, timestamp } = ctx.payload;
 *   // Handle the action
 * });
 *
 * // Handle toast dismissal
 * MakaioBus.on(ToastSubjects.dismissed, (ctx) => {
 *   const { toastId, timestamp } = ctx.payload;
 *   // Cleanup or track dismissal
 * });
 * ```
 */
import { createBusNamespace } from '@makaio/core';
import { ToastSchemas } from './schemas.js';

/**
 * Toast namespace definition.
 * Provides typed subjects for toast notification operations.
 */
export const ToastNamespace = createBusNamespace('toast', ToastSchemas);

/**
 * Toast subjects for type-safe bus operations.
 * Use these with MakaioBus.emit(), MakaioBus.on(), etc.
 */
export const ToastSubjects = ToastNamespace.subjects;
