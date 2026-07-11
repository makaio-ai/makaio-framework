/**
 * Signals that live connector state committed but its durable agent update did not.
 *
 * Callers must not describe this as a failed or rolled-back connector mutation:
 * the active runtime already reflects the requested state.
 */
export class AgentRuntimePersistenceError extends Error {
  public constructor() {
    super('Runtime mutation committed, but durable agent-state persistence failed.');
    this.name = 'AgentRuntimePersistenceError';
  }
}
