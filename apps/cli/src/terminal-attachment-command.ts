/** Interactive terminal relay for one supervised native runtime. @packageDocumentation */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { BusLifecycle, waitForSubscriptionPropagation, type IMakaioBus } from '@makaio/bus-core';
import {
  NativeSessionSupervisorSubjects,
  type NativeSupervisorAttachRequest,
  type NativeSupervisorTerminalOutput,
} from '@makaio/contracts';

/**
 * Open an interactive terminal attachment when standard I/O supports raw mode.
 * @param bus - Connected local Makaio bus.
 * @param locator - Runtime locator supplied by the CLI.
 */
export async function attachInteractiveTerminal(
  bus: IMakaioBus,
  locator: NativeSupervisorAttachRequest,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    await reportAttachmentStatus(bus, locator);
    return;
  }
  const relay = new TerminalAttachmentRelay(bus, locator);
  await relay.run();
}

/**
 * Preserve the existing non-interactive attach status response.
 * @param bus - Connected local Makaio bus.
 * @param request - Runtime locator supplied by the CLI.
 */
async function reportAttachmentStatus(bus: IMakaioBus, request: NativeSupervisorAttachRequest): Promise<void> {
  try {
    const response = await bus.request(NativeSessionSupervisorSubjects.attach, request);
    if (!response.success) {
      process.stderr.write('attach: runtime not found or attach failed\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Attached to runtime\n');
    if (response.supervisorSessionId !== undefined)
      process.stdout.write(`  supervisor session: ${response.supervisorSessionId}\n`);
    if (response.pid !== undefined) process.stdout.write(`  pid: ${response.pid}\n`);
    if (response.terminalAttachment !== undefined) {
      process.stdout.write(`  can attach terminal: ${String(response.terminalAttachment.canAttach)}\n`);
    }
  } catch (err) {
    process.stderr.write(`attach failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/** Stateful local terminal relay with a pre-subscription/replay boundary. */
class TerminalAttachmentRelay {
  private readonly attachmentId = randomUUID();
  private replayBoundary: number | null = null;
  private attached = false;
  private rawModeEnabled = false;
  private readonly inputDecoder = new StringDecoder('utf8');
  private readonly pendingFrames: NativeSupervisorTerminalOutput[] = [];
  private detachTerminal: (() => void) | undefined;
  private removeTerminationCleanup: (() => void) | undefined;

  public constructor(
    private readonly bus: IMakaioBus,
    private readonly locator: NativeSupervisorAttachRequest,
  ) {}

  /** Subscribe, attach, relay input and always restore terminal state. */
  public async run(): Promise<void> {
    const unsubscribe = this.bus.on(NativeSessionSupervisorSubjects.terminal.output, (event) => {
      if (event.payload.attachmentId === this.attachmentId) this.writeFrame(event.payload);
    });
    const unsubscribeClosed = this.bus.on(NativeSessionSupervisorSubjects.terminal.closed, (event) => {
      // The open response precedes closed events on this socket, and relay setup
      // installs detachTerminal without yielding after that response.
      if (event.payload.attachmentId === this.attachmentId) this.detachTerminal?.();
    });
    const unsubscribeDisconnected = this.bus.on(BusLifecycle.disconnected, () => this.detachTerminal?.());
    try {
      await waitForSubscriptionPropagation(unsubscribe);
      const response = await this.bus.request(NativeSessionSupervisorSubjects.terminal.open, {
        attachmentId: this.attachmentId,
        locator: this.locator,
      });
      if (!response.success || response.lastSeq === undefined) {
        process.stderr.write('attach: runtime not found or terminal attachment unavailable\n');
        process.exitCode = 1;
        return;
      }
      this.attached = true;
      this.startRelay(response.bufferedOutput ?? '', response.wasTruncated === true, response.lastSeq);
      await new Promise<void>((resolve) => {
        this.detachTerminal = resolve;
      });
    } catch (err) {
      process.stderr.write(`attach failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    } finally {
      this.stopRelay();
      unsubscribe();
      unsubscribeClosed();
      unsubscribeDisconnected();
      await this.close();
    }
  }

  /**
   * Apply replay before any buffered live frame with a newer sequence.
   * @param replay - Buffered terminal data.
   * @param wasTruncated - Whether buffered replay lost older output.
   * @param lastSeq - Last sequence included in replay.
   */
  private startRelay(replay: string, wasTruncated: boolean, lastSeq: number): void {
    if (wasTruncated) process.stderr.write('attach: terminal replay was truncated\n');
    if (replay.length > 0) process.stdout.write(replay);
    this.replayBoundary = lastSeq;
    for (const frame of this.pendingFrames) this.writeFrame(frame);
    this.pendingFrames.length = 0;
    process.stdin.setRawMode(true);
    this.rawModeEnabled = true;
    this.installTerminationCleanup();
    process.stdin.on('data', this.onData);
    process.on('SIGWINCH', this.onResize);
    this.onResize();
    process.stdout.write('\n[attached; press Ctrl-] to detach]\n');
  }

  /** Remove listeners and restore raw mode without stopping the runtime. */
  private stopRelay(): void {
    this.removeTerminationCleanup?.();
    this.removeTerminationCleanup = undefined;
    process.stdin.off('data', this.onData);
    process.stdin.pause();
    process.off('SIGWINCH', this.onResize);
    this.inputDecoder.end();
    if (this.rawModeEnabled) {
      process.stdin.setRawMode(false);
      this.rawModeEnabled = false;
    }
  }

  /** Restore the local terminal before the process exits for a terminating signal. */
  private installTerminationCleanup(): void {
    const onExit = () => this.detachAndStopRelay();
    const onSigterm = () => this.stopAndReraise('SIGTERM');
    const onSighup = () => this.stopAndReraise('SIGHUP');
    process.once('exit', onExit);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    this.removeTerminationCleanup = () => {
      process.off('exit', onExit);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
    };
  }

  /** Settle the relay waiter after restoring the terminal. */
  private detachAndStopRelay(): void {
    this.detachTerminal?.();
    this.stopRelay();
  }

  /**
   * Restore terminal state, then re-deliver the terminating signal to this process.
   * @param signal - The process signal that requested termination.
   */
  private stopAndReraise(signal: NodeJS.Signals): void {
    this.detachAndStopRelay();
    process.kill(process.pid, signal);
  }

  /** Close the authoritative attachment mapping if open succeeded. */
  private async close(): Promise<void> {
    if (!this.attached) return;
    try {
      await this.bus.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId: this.attachmentId });
    } catch (err) {
      process.stderr.write(`attach cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }

  private readonly onData = (data: Buffer): void => {
    const value = this.inputDecoder.write(data);
    const detachIndex = value.indexOf('\u001d');
    if (detachIndex >= 0) {
      const beforeDetach = value.slice(0, detachIndex);
      if (beforeDetach.length > 0) this.emitInput(beforeDetach);
      this.detachTerminal?.();
      return;
    }
    if (value.length > 0) this.emitInput(value);
  };

  private readonly onResize = (): void => {
    const { columns: cols, rows } = process.stdout;
    if (cols !== undefined && rows !== undefined && cols > 0 && rows > 0) {
      this.emitOrDetach(NativeSessionSupervisorSubjects.terminal.resize, {
        attachmentId: this.attachmentId,
        cols,
        rows,
      });
    }
  };

  private emitInput(data: string): void {
    this.emitOrDetach(NativeSessionSupervisorSubjects.terminal.input, { attachmentId: this.attachmentId, data });
  }

  /**
   * Forward a terminal control frame, detaching when the connection fails.
   * @param subject - Terminal input or resize subject to emit.
   * @param payload - Control payload for the current attachment.
   */
  private emitOrDetach(
    subject:
      | typeof NativeSessionSupervisorSubjects.terminal.input
      | typeof NativeSessionSupervisorSubjects.terminal.resize,
    payload: { attachmentId: string; data: string } | { attachmentId: string; cols: number; rows: number },
  ): void {
    void this.bus.request(subject, payload as never).catch(() => {
      this.detachTerminal?.();
    });
  }

  private writeFrame(frame: NativeSupervisorTerminalOutput): void {
    if (this.replayBoundary === null) {
      this.pendingFrames.push(frame);
    } else if (frame.seq > this.replayBoundary) {
      process.stdout.write(frame.data);
    }
  }
}
