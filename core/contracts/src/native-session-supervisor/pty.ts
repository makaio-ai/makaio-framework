/**
 * Structural handle for a running pseudoterminal process.
 *
 * This contract is implementation-agnostic so public adapters can describe
 * terminal capabilities without depending on the private supervisor runtime.
 */
export interface IPtyProcess {
  readonly pid: number;
  readonly process: string;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData: (listener: (data: string) => void) => { dispose(): void };
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => { dispose(): void };
}
