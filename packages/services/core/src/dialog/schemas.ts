import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Request user confirmation via UI.
 * Subject: `dialog.confirm`
 * Type: Request (RPC)
 * @returns The user's selected option ID, or null if dismissed without selection.
 *
 * NOTE: The UI handler must keep this request open until the user responds.
 * Bus timeouts should be set appropriately high for these requests.
 */
export const DialogConfirmSchema = {
  request: z.object({
    /** Dialog title */
    title: z.string(),
    /** Dialog message/description */
    message: z.string(),
    /** Available options (buttons) */
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger']).optional(),
      }),
    ),
    /** Optional detailed description */
    details: z.string().optional(),
    /** Show "Don't ask again" checkbox */
    showDontAskAgain: z.boolean().optional(),
    /** Optional positioning class or coordinates */
    position: z.enum(['center', 'top-center', 'bottom-center']).optional(),
  }),
  response: z.object({
    selectedOptionId: z.string().nullable(),
    dontAskAgain: z.boolean().optional(),
  }),
};

/**
 * Request text input via UI prompt dialog.
 * Subject: `dialog.prompt`
 * Type: Request (RPC)
 * @returns The user's entered text, or null if dismissed without input.
 *
 * NOTE: The UI handler must keep this request open until the user responds.
 * Bus timeouts should be set appropriately high for these requests.
 */
export const DialogPromptSchema = {
  request: z.object({
    /** Dialog title */
    title: z.string(),
    /** Dialog message/description */
    message: z.string(),
    /** Placeholder text for the input field */
    placeholder: z.string().optional(),
    /** Initial value for the input field */
    defaultValue: z.string().optional(),
    /** Whether to use a multiline textarea (default: false) */
    multiline: z.boolean().optional(),
    /** Label for the submit button (default: "Submit") */
    submitLabel: z.string().optional(),
    /** Label for the cancel button (default: "Cancel") */
    cancelLabel: z.string().optional(),
  }),
  response: z.object({
    value: z.string().nullable(),
  }),
};

export const DialogSchemas = {
  confirm: DialogConfirmSchema,
  prompt: DialogPromptSchema,
} satisfies SchemaRecord;

export type DialogConfirmRequest = z.infer<typeof DialogConfirmSchema.request>;
export type DialogConfirmResponse = z.infer<typeof DialogConfirmSchema.response>;
export type DialogPromptRequest = z.infer<typeof DialogPromptSchema.request>;
export type DialogPromptResponse = z.infer<typeof DialogPromptSchema.response>;
