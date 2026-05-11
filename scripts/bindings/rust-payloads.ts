/**
 * Explicit payload bindings for Rust subject descriptors backed by hand-authored Rust structs.
 */
const HAND_AUTHORED_RUST_TYPES: Record<string, { event?: string; request?: string; response?: string }> = {
  'agent.message': { event: 'AgentMessagePayload' },
  'agent.started': { event: 'AgentStartedPayload' },
  'agent.toolApprove': { request: 'AgentToolApproveRequest', response: 'AgentToolApproveResponse' },
  'approval.request': { request: 'ApprovalRequest', response: 'ApprovalResponse' },
  'tool.execute': { request: 'ToolExecuteRequest', response: 'ToolExecuteResponse' },
  'tool.started': { event: 'ToolLifecyclePayload' },
  'tool.completed': { event: 'ToolCompletedPayload' },
  'tool.error': { event: 'ToolErrorPayload' },
  'tool.registered': { event: 'ToolRegisteredPayload' },
  'tool.registryChanged': { event: 'ToolRegistryChangedPayload' },
};

/**
 * Build the conventional Rust type name for a generated payload, request, or response type.
 * @param fullSubject - Full protocol subject, such as `tool.execute`
 * @param suffix - Type suffix to append
 * @returns PascalCase Rust type name
 */
export function rustPayloadTypeName(fullSubject: string, suffix: 'Payload' | 'Request' | 'Response'): string {
  return (
    fullSubject
      .split(/[.:]/)
      .map((part) => part.replace(/(^|_)([a-z])/g, (_match, _prefix, char: string) => char.toUpperCase()))
      .join('') + suffix
  );
}

/**
 * Returns the Rust payload type bound to a subject descriptor, falling back to `Value` when no
 * representable Rust type exists yet.
 * @param fullSubject - Full protocol subject
 * @param slot - Event payload, request payload, or request response slot
 * @returns Rust type expression usable from inside a generated namespace module
 */
export function rustSubjectPayloadType(fullSubject: string, slot: 'event' | 'request' | 'response'): string {
  const handAuthored = HAND_AUTHORED_RUST_TYPES[fullSubject]?.[slot];
  return handAuthored ? `super::${handAuthored}` : 'Value';
}
