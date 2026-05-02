/**
 * Event collector utilities for SessionOrchestrator tests.
 * Subscribe to session bus events and accumulate payloads for test assertions.
 */
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { MessageInput, MessageOutcome, TurnInitiator } from '@makaio/contracts';
import type { SubjectDefinition, ExtractSubjectPayload, HandlerForSubjectDefinition } from '@makaio/core';

/** Collected event payloads for test assertions. */
export interface EventCollector<T> {
  received: T[];
  clear: () => void;
}
export type UnsubscribeFunction = () => void;

// Event payload types
type TurnStartedPayload = { sessionId: string; turnId: string; messageId: string; agentIds: string[] };
type TurnCompletedPayload = {
  sessionId: string;
  turnId: string;
  success: boolean;
  error?: string;
  initiator?: TurnInitiator;
};
type TurnStartedWithInitiatorPayload = TurnStartedPayload & { initiator?: TurnCompletedPayload['initiator'] };
type UserMessageSentPayload = {
  sessionId: string;
  turnId: string;
  messageId: string;
  content: MessageInput;
  agentIds: string[];
  origin?: 'voice' | 'text' | 'compact';
};
type UserMessageAcknowledgedPayload = { sessionId: string; turnId: string; messageId: string; agentId: string };
type UserMessageCompletedPayload = {
  sessionId: string;
  turnId: string;
  messageId: string;
  agentId: string;
  outcome: MessageOutcome;
  error?: string;
};

/**
 * Generic event collector factory. Subscribes to a subject, maps each payload, collects results.
 * @param subject - Bus subject to subscribe to
 * @param mapper - Transforms raw payload into the collected type
 * @param unsubscribers - Array to push cleanup function into
 * @returns Event collector with received array and clear function
 */
function collectEvents<TSubject extends SubjectDefinition, T>(
  subject: TSubject,
  mapper: (payload: ExtractSubjectPayload<TSubject>) => T,
  unsubscribers: UnsubscribeFunction[],
): EventCollector<T> {
  const received: T[] = [];
  const handler = ((context: unknown) => {
    const payload = (context as { payload: ExtractSubjectPayload<TSubject> }).payload;
    received.push(mapper(payload));
  }) as HandlerForSubjectDefinition<TSubject>;

  // Casts are safe: test subjects are never channel-only.
  // TypeScript cannot resolve the IsChannel conditional for unresolved generic type parameters.
  unsubscribers.push(MakaioBus.on(subject as never, handler as never));
  return {
    received,
    clear: () => {
      received.length = 0;
    },
  };
}

/**
 * Collect session.turn.started events including initiator metadata.
 * @param unsubs - Array to register the cleanup function into
 * @returns Event collector for turn started payloads
 */
export function collectTurnStartedEvents(
  unsubs: UnsubscribeFunction[],
): EventCollector<TurnStartedWithInitiatorPayload> {
  return collectEvents(
    SessionSubjects.turn.started,
    (p) => ({
      sessionId: p.sessionId,
      turnId: p.turnId,
      messageId: p.messageId,
      agentIds: [...p.agentIds],
      initiator: p.initiator,
    }),
    unsubs,
  );
}

/**
 * Collect session.turn.completed events.
 * @param unsubs - Array to register the cleanup function into
 * @returns Event collector for turn completed payloads
 */
export function collectTurnCompletedEvents(unsubs: UnsubscribeFunction[]): EventCollector<TurnCompletedPayload> {
  return collectEvents(
    SessionSubjects.turn.completed,
    (p) => ({
      sessionId: p.sessionId,
      turnId: p.turnId,
      success: p.success,
      error: p.error,
      initiator: p.initiator,
    }),
    unsubs,
  );
}

/**
 * Collect session.user_message.sent events.
 * @param unsubs - Array to register the cleanup function into
 * @returns Event collector for user message sent payloads
 */
export function collectUserMessageSentEvents(unsubs: UnsubscribeFunction[]): EventCollector<UserMessageSentPayload> {
  return collectEvents(
    SessionSubjects.user_message.sent,
    (p) => ({
      sessionId: p.sessionId,
      turnId: p.turnId,
      messageId: p.messageId,
      content: p.content,
      agentIds: [...p.agentIds],
      origin: p.origin,
    }),
    unsubs,
  );
}

/**
 * Collect session.user_message.acknowledged events.
 * @param unsubs - Array to register the cleanup function into
 * @returns Event collector for user message acknowledged payloads
 */
export function collectUserMessageAcknowledgedEvents(
  unsubs: UnsubscribeFunction[],
): EventCollector<UserMessageAcknowledgedPayload> {
  return collectEvents(
    SessionSubjects.user_message.acknowledged,
    (p) => ({
      sessionId: p.sessionId,
      turnId: p.turnId,
      messageId: p.messageId,
      agentId: p.agentId,
    }),
    unsubs,
  );
}

/**
 * Collect session.user_message.completed events.
 * @param unsubs - Array to register the cleanup function into
 * @returns Event collector for user message completed payloads
 */
export function collectUserMessageCompletedEvents(
  unsubs: UnsubscribeFunction[],
): EventCollector<UserMessageCompletedPayload> {
  return collectEvents(
    SessionSubjects.user_message.completed,
    (p) => ({
      sessionId: p.sessionId,
      turnId: p.turnId,
      messageId: p.messageId,
      agentId: p.agentId,
      outcome: p.outcome,
      error: p.error,
    }),
    unsubs,
  );
}
