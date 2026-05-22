import { z } from 'zod';

/**
 * Request user confirmation via UI.
 * UI renders a modal, user clicks option, response is sent back.
 *
 * Subject: `log-import.confirmation.request`
 * Type: Request (RPC)
 * Purpose: Requests user confirmation for actions like conflict resolution.
 */
export const LogImportConfirmationRequestSchema = {
  request: z.object({
    /** Unique ID for this confirmation request */
    confirmationId: z.string(),
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
  }),
  response: z.object({
    confirmationId: z.string(),
    received: z.boolean(),
  }),
};

export type LogImportConfirmationRequest = z.infer<typeof LogImportConfirmationRequestSchema.request>;
export type LogImportConfirmationRequestResponse = z.infer<typeof LogImportConfirmationRequestSchema.response>;

/**
 * User response to a log import confirmation dialog.
 *
 * Subject: `log-import.confirmation.response`
 * Type: Request (RPC)
 * Purpose: Sends the user's selection back to the requester.
 */
export const LogImportConfirmationResponseSchema = {
  request: z.object({
    confirmationId: z.string(),
    selectedOptionId: z.string(),
  }),
  response: z.object({
    acknowledged: z.boolean(),
  }),
};

export type LogImportConfirmationResponseRequest = z.infer<typeof LogImportConfirmationResponseSchema.request>;
export type LogImportConfirmationResponseResponse = z.infer<typeof LogImportConfirmationResponseSchema.response>;
