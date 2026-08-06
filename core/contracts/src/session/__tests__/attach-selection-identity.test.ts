import { describe, expect, it } from 'vitest';
import { OrchestratorSchemas } from '../schemas/orchestrator.js';

/**
 * Case 213, the attach face.
 *
 * `sendMessage` validated its selection through the adapter branch of the union
 * and `agent.attach` did not — it accepted the open base, where an `adapterId`
 * passed through unexamined and the handler's only honest answer was to refuse
 * native resume outright. Both entry points now share one validator, so the rule
 * that a named instance names its machine is stated once and holds at both.
 *
 * Asserted against the **schemas**, not through the bus: the test bus does not
 * validate payloads, so a request-driven version of this suite would be green
 * against a payload the contract forbids.
 */
describe('agent.attach selection identity (case 213)', () => {
  /** Minimal valid attach payload but for the selection under test. */
  const attachBase = { sessionId: 'session-1' } as const;

  it('rejects an attach whose selection names an instance without its machine', () => {
    const result = OrchestratorSchemas['agent.attach'].request.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', adapterId: 'adapter-1' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an attach whose selection names both halves', () => {
    const result = OrchestratorSchemas['agent.attach'].request.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', adapterId: 'adapter-1', machineId: 'machine-a' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an attach whose selection names a machine and no instance', () => {
    // The symmetric half, checked at this face too: both entry points share one
    // validator, so a rule added to the adapter branch has to hold here without
    // being restated — and a machine nothing resolves against is exactly the
    // belief that turns into a mis-key one step later.
    const result = OrchestratorSchemas['agent.attach'].request.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', machineId: 'machine-a' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an attach that names only the adapter type', () => {
    const result = OrchestratorSchemas['agent.attach'].request.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk' },
    });

    expect(result.success).toBe(true);
  });

  it('still accepts host-registered selection kinds, which carry no adapter identity at all', () => {
    // The union's third member. Sharing the validator with `sendMessage` must not
    // narrow attach to framework kinds: persona, profile and virtual-model
    // selections are resolved by a host-tier resolver and are only refused if the
    // *adapter* branch has swallowed them.
    const result = OrchestratorSchemas['agent.attach'].request.safeParse({
      ...attachBase,
      agent: { kind: 'persona', personaId: 'persona-1' },
    });

    expect(result.success).toBe(true);
  });

  it('applies the same rule to the local resolved-provider attach seam', () => {
    // `agent.attachResolved` extends the same adapter selection, so it inherits the
    // refinement rather than restating it — the shape a framework runtime uses when
    // it resolved credentials before delegating.
    const resolvedAttach = OrchestratorSchemas['agent.attachResolved'].schema.request;
    const refused = resolvedAttach.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', adapterId: 'adapter-1' },
    });
    const refusedReverse = resolvedAttach.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', machineId: 'machine-a' },
    });
    const accepted = resolvedAttach.safeParse({
      ...attachBase,
      agent: { kind: 'adapter', adapterName: 'anthropic-sdk', adapterId: 'adapter-1', machineId: 'machine-a' },
    });

    expect(refused.success).toBe(false);
    expect(refusedReverse.success).toBe(false);
    expect(accepted.success).toBe(true);
  });
});
