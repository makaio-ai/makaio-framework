import { type SubjectDefinition, WildcardSubjectKey } from '@makaio/core';
import { ChannelOnlyError } from '../errors/channel-only-error.js';

/**
 * Validates message operations to ensure subjects are used correctly
 * according to bus rules. Checks for valid subject metadata, namespace
 * matching, and method-specific constraints (e.g., no wildcard emits,
 * no emitting to request subjects, no channel subjects on the public bus).
 * @param method - The message operation type being performed
 * @param subject - The subject definition to validate
 * @param scopeNamespace - Optional namespace to validate against the subject's namespace
 * @returns void
 * @throws {@link ChannelOnlyError} when a channel subject is used on the public bus
 * @throws Error when subject metadata is invalid, namespace mismatch occurs,
 *   or method-specific validation fails (wildcards in emit, emitting to request subjects)
 */
export function validateMessage(
  method: 'on' | 'once' | 'emit' | 'request' | 'intercept',
  subject: SubjectDefinition,
  scopeNamespace?: string,
) {
  if (!subject?.$meta) {
    throw new Error(`Invalid subject definition provided to ${method}()`);
  }

  if (subject.$meta.channel) {
    throw new ChannelOnlyError(String(subject.subject));
  }

  if (scopeNamespace) {
    const messageNamespace = subject?.$meta?.namespace ?? '(NO NAMESPACE)';
    if (messageNamespace !== scopeNamespace)
      throw new Error(`Subject namespace ${messageNamespace} does not match scoped bus namespace ${scopeNamespace}`);
  }

  if (method === 'emit') {
    if (subject.$meta.isRequest) throw new Error('Cannot emit to request subjects. Use event subjects only.');

    if (subject.subject?.includes(WildcardSubjectKey))
      throw new Error('Emitting wildcard subjects is not allowed. Use concrete subject keys only.');
  }

  if (method === 'intercept') {
    if (subject.$meta.isRequest === true)
      throw new Error('intercept() only supports event subjects, not request subjects. Use middleware for requests.');

    if (subject.subject?.includes(WildcardSubjectKey))
      throw new Error('intercept() requires exact subjects, not wildcards. Wildcards are only supported for on().');
  }
}
