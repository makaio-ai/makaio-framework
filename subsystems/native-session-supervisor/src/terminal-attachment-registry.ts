/**
 * In-memory routing for interactive terminal attachments of supervised PTYs.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import type { NativeSupervisorTerminalOpenResponse } from '@makaio/contracts/native-session-supervisor';
import type { CallContext } from '@makaio/core';
import { PtyRuntime } from './pty/pty-runtime.js';
import type { PtyOutputEvent } from './pty/types.js';

/** Running runtime identity needed to open an attachment. */
export interface TerminalRuntimeTarget {
  readonly supervisorSessionId: string;
}

/**
 * Observes the close of a connection on a named transport.
 *
 * Supplied by the host that owns the transport registry so the attachment registry
 * does not reach into bus internals.
 * @param transportName - Transport whose connection closes are observed.
 * @param onClosed - Called with the identity of each closed connection.
 * @returns Function that stops observing, or `undefined` when no transport of that name exists.
 */
export type ConnectionCloseObserver = (
  transportName: string,
  onClosed: (connectionId: string) => void,
) => (() => void) | undefined;

/** Transport and connection selection for one terminal emission. */
interface TerminalDeliveryOptions {
  readonly transports: string[];
  readonly connectionId?: string;
}

interface TerminalAttachment {
  readonly supervisorSessionId: string;
  readonly transportName?: string;
  readonly connectionId?: string;
}

/** Routes non-authoritative attachment IDs to active PTY sessions. */
export class TerminalAttachmentRegistry {
  private readonly attachments = new Map<string, TerminalAttachment>();
  private readonly connectionCloseUnsubscribers = new Map<string, () => void>();

  /**
   * @param bus - Bus used to emit terminal output and close frames.
   * @param ptyRuntime - PTY runtime that backs the attachments.
   * @param observeConnectionClosed - Observes transport connection closes to release owned attachments.
   */
  public constructor(
    private readonly bus: IMakaioBus,
    private readonly ptyRuntime: PtyRuntime,
    private readonly observeConnectionClosed: ConnectionCloseObserver,
  ) {}

  /**
   * Open one attachment after its client subscribed to terminal output.
   * @param attachmentId - Caller-generated routing correlation.
   * @param target - Resolved running runtime.
   * @param transportName - Receiving transport that owns a remote attachment.
   * @param connectionId - Trusted connection identity for a remote attachment.
   * @returns Initial terminal replay or an unavailable result.
   */
  public open(
    attachmentId: string,
    target: TerminalRuntimeTarget | null,
    transportName?: string,
    connectionId?: string,
  ): NativeSupervisorTerminalOpenResponse {
    if (target === null || this.attachments.has(attachmentId)) return { success: false };
    if ((transportName === undefined) !== (connectionId === undefined)) return { success: false };
    // Insert before connect: an already-running supervisor subscription may emit
    // output synchronously while this request is completing.
    if (transportName !== undefined && connectionId !== undefined) this.observeConnection(transportName);
    this.attachments.set(attachmentId, {
      supervisorSessionId: target.supervisorSessionId,
      transportName,
      connectionId,
    });
    const replay = this.ptyRuntime.connect(target.supervisorSessionId, null);
    if (replay === null) {
      this.attachments.delete(attachmentId);
      return { success: false };
    }
    return {
      success: true,
      supervisorSessionId: target.supervisorSessionId,
      pid: replay.pid,
      bufferedOutput: replay.bufferedOutput,
      wasTruncated: replay.wasTruncated,
      lastSeq: replay.lastSeq,
    };
  }

  /**
   * Forward input only for an open attachment.
   * @param attachmentId - Attachment routing correlation.
   * @param data - Bytes represented as a string.
   * @param transportName - Receiving transport that opened the attachment.
   * @param connectionId - Trusted connection identity that opened the attachment.
   */
  public write(attachmentId: string, data: string, transportName?: string, connectionId?: string): void {
    const attachment = this.getOwnedAttachment(attachmentId, transportName, connectionId);
    if (attachment === undefined) {
      throw new Error(`Terminal attachment '${attachmentId}' is not open`);
    }
    this.ptyRuntime.write(attachment.supervisorSessionId, data);
  }

  /**
   * Resize only for an open attachment.
   * @param attachmentId - Attachment routing correlation.
   * @param cols - Terminal columns.
   * @param rows - Terminal rows.
   * @param transportName - Receiving transport that opened the attachment.
   * @param connectionId - Trusted connection identity that opened the attachment.
   */
  public resize(attachmentId: string, cols: number, rows: number, transportName?: string, connectionId?: string): void {
    const attachment = this.getOwnedAttachment(attachmentId, transportName, connectionId);
    if (attachment === undefined) {
      throw new Error(`Terminal attachment '${attachmentId}' is not open`);
    }
    this.ptyRuntime.resize(attachment.supervisorSessionId, cols, rows);
  }

  /**
   * Detach without stopping the underlying PTY.
   * @param attachmentId - Attachment routing correlation.
   * @param transportName - Receiving transport that opened the attachment.
   * @param connectionId - Trusted connection identity that opened the attachment.
   * @returns Whether an open attachment was removed.
   */
  public close(attachmentId: string, transportName?: string, connectionId?: string): boolean {
    const attachment = this.getOwnedAttachment(attachmentId, transportName, connectionId);
    if (attachment === undefined) return false;
    // Delete first so a concurrently delivered frame cannot route after close.
    this.attachments.delete(attachmentId);
    return this.ptyRuntime.disconnect(attachment.supervisorSessionId);
  }

  /**
   * Drop attachments whose PTY has exited.
   * @param call - Call context of the exit processing that releases the attachments.
   * @param supervisorSessionId - Runtime that exited.
   */
  public releaseRuntime(call: CallContext, supervisorSessionId: string): void {
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.supervisorSessionId !== supervisorSessionId) continue;
      // Emit while ownership still exists so the close signal is connection-scoped.
      this.emitClosed(call, attachment, { attachmentId });
      this.attachments.delete(attachmentId);
    }
  }

  /** Forget every attachment during supervisor teardown. */
  public clear(): void {
    this.attachments.clear();
    for (const unsubscribe of this.connectionCloseUnsubscribers.values()) unsubscribe();
    this.connectionCloseUnsubscribers.clear();
  }

  /**
   * Emit a frame separately for each attachment of its runtime.
   * @param evt - PTY output frame to route.
   */
  public routeOutput(evt: PtyOutputEvent): void {
    const call = this.bus.own('observer');
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.supervisorSessionId !== evt.supervisorSessionId) continue;
      this.emitOutput(call, attachment, { attachmentId, seq: evt.seq, data: evt.data });
    }
  }

  private getOwnedAttachment(
    attachmentId: string,
    transportName?: string,
    connectionId?: string,
  ): TerminalAttachment | undefined {
    const attachment = this.attachments.get(attachmentId);
    if (attachment === undefined) return undefined;
    return attachment.transportName === transportName && attachment.connectionId === connectionId
      ? attachment
      : undefined;
  }

  private observeConnection(transportName: string): void {
    if (this.connectionCloseUnsubscribers.has(transportName)) return;
    const unsubscribe = this.observeConnectionClosed(transportName, (connectionId) => {
      for (const [attachmentId, attachment] of this.attachments) {
        if (attachment.transportName === transportName && attachment.connectionId === connectionId) {
          this.close(attachmentId, transportName, connectionId);
        }
      }
    });
    if (unsubscribe !== undefined) this.connectionCloseUnsubscribers.set(transportName, unsubscribe);
  }

  /**
   * Delivery options that confine a frame to the attachment's own receiver.
   * @param attachment - Attachment the frame is routed to.
   * @returns Transport and connection selection for the emission.
   */
  private deliveryOptions(attachment: TerminalAttachment): TerminalDeliveryOptions {
    return {
      // A local attachment must never use the bus default fan-out; remote
      // attachments select their owning transport and connection explicitly.
      transports: attachment.transportName === undefined ? [] : [attachment.transportName],
      ...(attachment.connectionId !== undefined && { connectionId: attachment.connectionId }),
    };
  }

  /**
   * Emit one PTY output frame to a single attachment.
   * @param call - Call context of the PTY output observer.
   * @param attachment - Attachment the frame is routed to.
   * @param payload - Output frame.
   */
  private emitOutput(
    call: CallContext,
    attachment: TerminalAttachment,
    payload: { attachmentId: string; seq: number; data: string },
  ): void {
    void this.bus
      .emit(call, NativeSessionSupervisorSubjects.terminal.output, payload, this.deliveryOptions(attachment))
      .catch(() => {
        // A disconnected terminal receiver must not affect the supervised PTY.
      });
  }

  /**
   * Emit the close signal to a single attachment.
   * @param call - Call context of the exit processing that releases the attachment.
   * @param attachment - Attachment the signal is routed to.
   * @param payload - Close frame.
   */
  private emitClosed(call: CallContext, attachment: TerminalAttachment, payload: { attachmentId: string }): void {
    void this.bus
      .emit(call, NativeSessionSupervisorSubjects.terminal.closed, payload, this.deliveryOptions(attachment))
      .catch(() => {
        // A disconnected terminal receiver must not affect the supervised PTY.
      });
  }
}
