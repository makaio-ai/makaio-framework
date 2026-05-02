/**
 * Toast namespace registration — has side effects (registers on the bus).
 *
 * For pure Zod schemas without side effects, import `./schemas` instead.
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
import { MakaioBus } from '@makaio/bus-core';
import { ToastSchemas } from './schemas.js';

/**
 * Toast namespace registration.
 * Provides typed subjects for toast notification operations.
 */
export const ToastNamespace = MakaioBus.registerNamespace('toast', ToastSchemas);

/**
 * Toast subjects for type-safe bus operations.
 * Use these with MakaioBus.emit(), MakaioBus.on(), etc.
 */
export const ToastSubjects = ToastNamespace.subjects;
