import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { callerOwnedSuccessFields } from '../testing/caller-owned-adapter-stub.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

export const RECOVERY_HELPERS_MACHINE_ID = 'recovery-helpers-machine';

/** Fully composed host for recovery-helper tests. */
export class RecoveryHelpersHarness {
  public readonly bus: IMakaioBus = createBusInstance();
  public readonly service = new MakaioSessionService(this.bus, { machineId: RECOVERY_HELPERS_MACHINE_ID });
  private cleanups: Array<() => void> = [];

  /** Initialize storage, ownership authority and adapter identity handlers. */
  public async init(): Promise<void> {
    this.cleanups = [
      ...registerMemorySessionBackends(this.bus),
      this.bus.on(AdapterSubjects.acknowledgeCallerSettlement, (ctx) => {
        ctx.setResult({ acknowledged: true });
      }),
      this.bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
      }),
      this.bus.on(AdapterRuntimeSubjects.resolveLiveIdentity, (ctx) => {
        ctx.setResult({
          adapterId: ctx.payload.adapterId,
          adapterName: ctx.payload.adapterName,
          machineId: ctx.payload.machineId,
          ownerInstanceId: this.service.requireOwnershipInstanceId(),
        });
      }),
    ];
    await this.service.init();
  }

  /** Dispose service and every registered handler. */
  public destroy(): void {
    this.service.destroy();
    for (let index = this.cleanups.length - 1; index >= 0; index -= 1) this.cleanups[index]?.();
    this.cleanups = [];
  }

  /**
   * Seed a session and one agent row the ownership seam can verify.
   * @param agentId - Agent identifier.
   * @param overrides - Agent field overrides.
   * @returns The stored agent record.
   */
  public async seedAgent(agentId: string, overrides?: Partial<MakaioSessionAgent>): Promise<MakaioSessionAgent> {
    const sessionId = overrides?.sessionId ?? 'session-recovery-1';
    await this.bus.request(SessionSubjects.create, { sessionId, machineId: RECOVERY_HELPERS_MACHINE_ID });
    const agent = createTestAgent(agentId, {
      adapterName: 'claude-code',
      adapterId: 'stale-adapter-id',
      status: 'dead',
      role: 'lead',
      runtimeOwner: { machineId: RECOVERY_HELPERS_MACHINE_ID, instanceId: this.service.requireOwnershipInstanceId() },
      ...overrides,
      sessionId,
    });
    await this.bus.request(AgentStorageSubjects.set, { agentId, agent });
    return agent;
  }

  /**
   * Register cleanup managed by this harness.
   * @param cleanup - Handler cleanup function.
   */
  public addCleanup(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  /**
   * Answer rehydrates as the adapter does, recording every payload.
   * @returns The captured payloads, in order.
   */
  public captureRehydrates(): Array<Record<string, unknown>> {
    const payloads: Array<Record<string, unknown>> = [];
    this.addCleanup(
      this.bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        payloads.push(ctx.payload);
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );
    return payloads;
  }

  /**
   * Report every agent as dead, so the recovery path is the one under test.
   * @returns The probes that recovery issued.
   */
  public reportAgentsDead(): Array<{ agentId: string; ownerInstanceId: string }> {
    const probes: Array<{ agentId: string; ownerInstanceId: string }> = [];
    this.addCleanup(
      this.bus.on(AdapterSubjects.getAgent, (ctx) => {
        probes.push({ agentId: ctx.payload.agentId, ownerInstanceId: ctx.payload.ownerInstanceId });
        ctx.setResult({ agent: null });
      }),
    );
    return probes;
  }
}
