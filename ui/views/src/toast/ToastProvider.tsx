import { useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { IMakaioBus } from '@makaio/bus-core';
import { Toaster, toast as sonnerToast } from 'sonner';
import { ToastSubjects } from '@makaio/contracts/toast';
import type { ToastAction } from '@makaio/contracts/toast';
import { MultiActionToast } from '@makaio/ui-components';

export interface ToastProviderProps {
  /**
   * The bus instance to use for toast communication
   */
  bus: IMakaioBus;
  /**
   * Optional application content to render alongside the Toaster.
   */
  children?: ReactNode;
}

/**
 * Toast notification provider.
 *
 * Renders the <Toaster /> component and listens for toast.show events on the bus.
 * Emits toast.interacted and toast.dismissed events for action handling and cleanup.
 * @param props - Component properties containing the bus instance
 * @example
 * ```tsx
 * import { ToastProvider } from '@makaio/ui-views';
 * import { MakaioBus } from '@makaio/bus-core';
 *
 * function App() {
 *   return (
 *     <ToastProvider bus={MakaioBus}>
 *       <YourAppContent />
 *     </ToastProvider>
 *   );
 * }
 * ```
 */
export function ToastProvider({ bus, children }: ToastProviderProps): React.ReactElement {
  const handleActionClick = useCallback(
    (toastId: string, action: ToastAction) => {
      return (event: React.MouseEvent) => {
        event.preventDefault();
        void bus.emit(ToastSubjects.interacted, {
          toastId,
          actionId: action.id,
          timestamp: Date.now(),
        });
        sonnerToast.dismiss(toastId);
      };
    },
    [bus],
  );

  useEffect(() => {
    const cleanupShow = bus.on(ToastSubjects.show, (ctx) => {
      const { actions, level, message, title, durationMs } = ctx.payload;
      const toastId = ctx.payload.toastId ?? crypto.randomUUID();

      const duration = durationMs === null ? Infinity : (durationMs ?? 4000);

      // Handle dismiss callback
      const onDismiss = () => {
        void bus.emit(ToastSubjects.dismissed, {
          toastId,
          timestamp: Date.now(),
        });
      };

      const options = {
        duration,
        onDismiss,
        onAutoClose: onDismiss,
        id: toastId,
      };

      const toastFn = (() => {
        switch (level) {
          case 'success':
            return sonnerToast.success;
          case 'info':
            return sonnerToast.info;
          case 'warning':
            return sonnerToast.warning;
          case 'error':
            return sonnerToast.error;
          default:
            return sonnerToast;
        }
      })();

      // 0 actions: standard toast
      if (!actions || actions.length === 0) {
        const content = title ?? message;
        toastFn(content, {
          ...options,
          description: title ? message : undefined,
        });
        return;
      }

      // 1 action: use sonner's built-in action
      if (actions.length === 1) {
        const action = actions[0];
        const content = title ?? message;
        toastFn(content, {
          ...options,
          description: title ? message : undefined,
          action: {
            label: action.label,
            onClick: (event: React.MouseEvent) => handleActionClick(toastId, action)(event),
          },
        });
        return;
      }

      // 2+ actions: render custom multi-action toast
      const payload = {
        level,
        message,
        title,
        durationMs,
        actions,
        toastId,
      };
      sonnerToast.custom(
        (id) => (
          <MultiActionToast
            payload={payload}
            onAction={(actionId) => {
              void bus.emit(ToastSubjects.interacted, {
                toastId,
                actionId,
                timestamp: Date.now(),
              });
              sonnerToast.dismiss(id);
            }}
            onDismiss={() => sonnerToast.dismiss(id)}
          />
        ),
        options,
      );
    });

    const cleanupDismiss = bus.on(ToastSubjects.dismiss, (ctx) => {
      sonnerToast.dismiss(ctx.payload.toastId);
    });

    return () => {
      cleanupShow();
      cleanupDismiss();
    };
  }, [bus, handleActionClick]);

  return (
    <>
      <Toaster position="bottom-right" />
      {children}
    </>
  );
}
