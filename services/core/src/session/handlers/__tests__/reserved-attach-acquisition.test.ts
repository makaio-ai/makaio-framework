/**
 * Path D — the acquisition frame the attach's first write sits in.
 *
 * The row is written before anything else, and that write is a round trip like
 * any other: its transaction can commit while its response is lost. A rollback
 * region that began after it would never see the row it left, and a `starting`
 * row with no reservation, no owner and no connector is the phantom every later
 * send has to arbitrate over. The frame therefore starts at the write's issue,
 * exactly as the adapter's own row acquisition does (I20).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { getSessionAgentAttachError } from '../attach-error.js';
import { type StartAgentRequestPayload } from './shared.js';
import { createReservedAttachContext, type ReservedAttachContext } from './reserved-attach-fixture.js';

describe('reserved attach acquisition', () => {
  let fixture: ReservedAttachContext;
  let ctx: ReservedAttachContext['ctx'];
  let dispatched: StartAgentRequestPayload[];
  /** Row deletions, in the order storage saw them. */
  let rowDeletes: number;

  beforeEach(() => {
    fixture = createReservedAttachContext();
    ({ ctx, dispatched } = fixture);
    rowDeletes = 0;
    ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.delete,
        (deleteCtx) => {
          rowDeletes += 1;
          return deleteCtx.next();
        },
        { priority: 1000 },
      ),
    );
  });

  afterEach(() => {
    fixture.destroy();
  });

  const seedSession: ReservedAttachContext['seedSession'] = (overrides) => fixture.seedSession(overrides);
  const registerAdapter: ReservedAttachContext['registerAdapter'] = (respond) => fixture.registerAdapter(respond);
  const attach: ReservedAttachContext['attach'] = (overrides) => fixture.attach(overrides);

  it('deletes the row when the write that stored it throws after committing', async () => {
    // The write that opens this path is a round trip like any other: its
    // transaction can commit and its response can still be lost. The row is then
    // stored — `starting`, with no reservation, no owner and no connector — and a
    // rollback that began *after* the write would never see it. Once the
    // exclusive-start entry is gone the in-flight rule arbitrates it as a phantom
    // attach, which is the state this whole discipline exists to remove.
    seedSession();
    ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.set,
        (writeCtx) => {
          // Committed, then lost: the row is written through to the store and the
          // caller is told the request failed.
          writeCtx.next();
          throw new Error('agent storage response was lost');
        },
        { priority: 1001 },
      ),
    );
    registerAdapter();

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    // A modeled refusal, and the disposition every pre-dispatch refusal carries:
    // nothing reached the provider.
    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ dispatch: 'not-dispatched' });
    expect(dispatched).toHaveLength(0);
    // And the row the write left behind is gone: the delete ran even though the
    // write reported failure, because whether it landed is exactly what a lost
    // response does not say.
    expect(rowDeletes).toBe(1);
  });
});
