import type { JsonValue } from '@makaio/contracts';

/** Read-only access to the live rights directory and candidate resolution. */
export interface RuleValidationRights {
  /** @returns Declared right names. */
  listRights(): readonly string[];
  /** @param pattern - Proposed subscription.
   * @param check - Catalog context of the candidate.
   * @returns Whether the evaluator may subscribe.
   */
  canSubscribe(pattern: string, check: JsonValue | undefined): Promise<boolean>;
  /** @param subject - Proposed request.
   * @param check - Catalog context of the candidate.
   * @returns Whether the evaluator may send.
   */
  canSend(subject: string, check: JsonValue | undefined): Promise<boolean>;
}
