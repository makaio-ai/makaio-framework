/**
 * Union of all hook names.
 * - Named hooks provide enriched context (session, history, etc.)
 * - BusMessage is the generic escape hatch for any subject
 */
export type HookName =
  | 'BusMessage'
  | 'PreUserMessage'
  | 'PostUserMessage'
  | 'PreTurn'
  | 'PostTurn'
  | 'PostStep'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd';
