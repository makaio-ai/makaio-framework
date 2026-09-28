/**
 * Shared helpers for the `CodexClientSessionService` test files.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type RawClientHookPayload } from '@makaio/subsystem-client';
import type { ClientRuntimeStarted } from '@makaio/contracts/client';
import { CodexClientSubjects } from '../namespace.js';

export type CapturedClientSessionSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.started
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post
  | typeof ClientSubjects.session.subagent.started
  | typeof ClientSubjects.session.subagent.completed
  | typeof ClientSubjects.session.compaction.pre;

/**
 * Capture payloads emitted on one or more client session subjects.
 * @param bus - Test bus instance
 * @param subjects - Client session subjects to observe
 * @returns Captured payloads and a cleanup function
 */
export function capturePayloads(
  bus: IMakaioBus,
  ...subjects: CapturedClientSessionSubject[]
): { received: unknown[]; cleanup: () => void } {
  const received: unknown[] = [];
  const cleanups = subjects.map((subject) =>
    bus.on(subject, (ctx: { payload: unknown }) => {
      received.push(ctx.payload);
    }),
  );
  return {
    received,
    cleanup: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

/**
 * Emit a raw hook event on the test bus and wait for the emission to settle.
 * @param bus - Test bus instance
 * @param eventName - Codex-native hook event name
 * @param payload - Raw payload forwarded by the ingress bridge
 * @param metadata - Optional bridge metadata
 */
export async function emitRawHook(
  bus: IMakaioBus,
  eventName: string,
  payload: RawClientHookPayload['payload'] = {},
  metadata?: RawClientHookPayload['metadata'],
): Promise<void> {
  await bus.emit(CodexClientSubjects.hook.received, {
    eventName,
    receivedAt: 1_713_795_200_000,
    payload,
    metadata,
  });
}

/**
 * Emits a `client.runtime.started` event on the test bus with sensible
 * defaults for the adapter-managed session gate tests.
 * @param bus - Test bus instance
 * @param overrides - Partial payload merged over the defaults
 * @returns Resolves once the emission settled
 */
export function emitRuntimeStarted(bus: IMakaioBus, overrides: Partial<ClientRuntimeStarted> = {}): Promise<void> {
  const { source: overrideSource, adapterSessionId: overrideAdapterSessionId, ...rest } = overrides;
  const source = overrideSource ?? { layer: 'adapter', producer: 'codex-app-server' };
  const adapterSessionId = source.layer === 'adapter' ? (overrideAdapterSessionId ?? 'sess-1') : undefined;
  return bus.emit(ClientSubjects.runtime.started, {
    clientRuntimeId: 'rt-default',
    clientId: 'codex',
    status: 'started',
    observedAt: 1_713_795_200_000,
    ...rest,
    source,
    ...(adapterSessionId !== undefined ? { adapterSessionId } : {}),
  });
}
