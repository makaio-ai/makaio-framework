import { z } from 'zod';
import { ExtensionNameSchema } from '@makaio/core';

/**
 * An account of an external system, as witnessed by an extension.
 *
 * A witnessed account is an account of an external system named in a delivery
 * whose authenticity the receiving extension verified (the author of a
 * comment, the sender of a mail), or an account a verifier of that extension
 * delivered at its own route. An extension only witnesses accounts of its own
 * system. The same shape is the key of an external account in any mapping to a
 * party of the host.
 */
export const WitnessedAccountSchema = z
  .object({
    /** The extension that owns the account's system. */
    extension: ExtensionNameSchema,
    /** Instance of the system the account belongs to (installation, organisation, mailbox). */
    site: z.string().min(1),
    /** Identifier of the account in that system. */
    accountId: z.string().min(1),
    /** Display name, for people. */
    display: z.string().optional(),
  })
  .strict();
/** An account of an external system, as witnessed by an extension. */
export type WitnessedAccount = z.infer<typeof WitnessedAccountSchema>;
