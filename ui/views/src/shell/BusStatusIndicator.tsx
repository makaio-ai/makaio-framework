import { useEffect, useRef, useState, type JSX } from 'react';
import { KernelSubjects } from '@makaio/kernel';
import { useBus } from '@makaio/ui-hooks';
import styles from './BusStatusIndicator.module.scss';

type BusStatus = 'connected' | 'disconnected';

const DOT_CLASS: Record<BusStatus, string> = {
  connected: styles.dotConnected,
  disconnected: styles.dotDisconnected,
};

/**
 * Colored dot with text indicating bus connection state.
 *
 * Polls `KernelSubjects.isReady` every 5 seconds; shows green when the
 * round-trip succeeds and red on failure. StrictMode-safe via run-ID pattern.
 * @returns Inline status indicator element.
 */
export function BusStatusIndicator(): JSX.Element {
  const bus = useBus();
  const runIdRef = useRef(0);
  const [status, setStatus] = useState<BusStatus>('disconnected');

  useEffect(() => {
    const currentRunId = ++runIdRef.current;
    const isCurrentRun = (): boolean => runIdRef.current === currentRunId;

    const checkConnection = async (): Promise<void> => {
      try {
        await bus.request(KernelSubjects.isReady, {});
        if (isCurrentRun()) {
          setStatus('connected');
        }
      } catch {
        if (isCurrentRun()) {
          setStatus('disconnected');
        }
      }
    };

    void checkConnection();
    const intervalId = globalThis.setInterval(() => {
      void checkConnection();
    }, 5000);

    return () => {
      ++runIdRef.current;
      globalThis.clearInterval(intervalId);
    };
  }, [bus]);

  return (
    <span className={styles.indicator} data-component="BusStatusIndicator">
      <span aria-hidden="true" className={`${styles.dot} ${DOT_CLASS[status]}`} />
      {status === 'connected' ? 'Connected' : 'Disconnected'}
    </span>
  );
}
