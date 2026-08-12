import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { getSessionAgentAttachError } from '../attach-error.js';
import { createReservedAttachContext, type ReservedAttachContext } from './reserved-attach-fixture.js';

/** Cleanup errors must never replace an already-classified start refusal. */
describe('reserved attach cleanup errors', () => {
  let fixture: ReservedAttachContext;

  beforeEach(() => {
    fixture = createReservedAttachContext();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('keeps the not-dispatched attach failure when rollback deletion throws', async () => {
    fixture.seedSession();
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.delete,
        async (context) => {
          await context.next();
          throw new Error('rollback delete response was lost');
        },
        { priority: 1001 },
      ),
    );
    fixture.registerAdapter(() => ({ success: false, message: 'not sent', dispatch: 'not-dispatched' }));

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({
      code: 'start-failed',
      dispatch: 'not-dispatched',
    });
  });

  it('does not report a clean lead-conflict when the loser row cannot be deleted', async () => {
    const session = fixture.seedSession();
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (context) => {
          session.leadAgentId = 'conflict-winner';
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.delete,
        () => {
          throw new Error('rollback delete failed before commit');
        },
        { priority: 1000 },
      ),
    );
    fixture.registerAdapter();

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({
      code: 'start-failed',
      dispatch: 'not-dispatched',
    });
    expect(fixture.dispatched).toEqual([]);
  });
});
