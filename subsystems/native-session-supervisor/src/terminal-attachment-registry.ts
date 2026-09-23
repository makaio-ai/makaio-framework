/**
 * In-memory routing for interactive terminal attachments of supervised PTYs.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import type { NativeSupervisorTerminalOpenResponse } from '@makaio/contracts/native-session-supervisor';
import { PtyRuntime } from './pty/pty-runtime.js';
import type { PtyOutputEvent } from './pty/types.js';

/** Running runtime identity needed to open an attachment. */
export interface TerminalRuntimeTarget {
  readonly supervisorSessionId: string;
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

  public constructor(
    private readonly bus: IMakaioBus,
    private readonly ptyRuntime: PtyRuntime,
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
   * @param supervisorSessionId - Runtime that exited.
   */
  public releaseRuntime(supervisorSessionId: string): void {
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.supervisorSessionId !== supervisorSessionId) continue;
      // Emit while ownership still exists so the close signal is connection-scoped.
      this.emitForAttachment(NativeSessionSupervisorSubjects.terminal.closed, { attachmentId }, attachment);
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
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.supervisorSessionId !== evt.supervisorSessionId) continue;
      this.emitForAttachment(
        NativeSessionSupervisorSubjects.terminal.output,
        { attachmentId, seq: evt.seq, data: evt.data },
        attachment,
      );
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
    const transport = this.bus.getContext().transportRegistry.getTransport(transportName);
    const unsubscribe = transport?.onConnectionClosed?.((connectionId) => {
      for (const [attachmentId, attachment] of this.attachments) {
        if (attachment.transportName === transportName && attachment.connectionId === connectionId) {
          this.close(attachmentId, transportName, connectionId);
        }
      }
    });
    if (unsubscribe !== undefined) this.connectionCloseUnsubscribers.set(transportName, unsubscribe);
  }

  private emitForAttachment(
    subject:
      | typeof NativeSessionSupervisorSubjects.terminal.output
      | typeof NativeSessionSupervisorSubjects.terminal.closed,
    payload: { attachmentId: string; seq: number; data: string } | { attachmentId: string },
    attachment: TerminalAttachment,
  ): void {
    void this.bus
      .emit(subject, payload as never, {
        // A local attachment must never use the bus default fan-out; remote
        // attachments select their owning transport and connection explicitly.
        transports: attachment.transportName === undefined ? [] : [attachment.transportName],
        ...(attachment.connectionId !== undefined && { connectionId: attachment.connectionId }),
      })
      .catch(() => {
        // A disconnected terminal receiver must not affect the supervised PTY.
      });
  }
}
