import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';

interface SheetProps {
  readonly open: boolean;
  readonly onClose?: () => void;
  readonly label: string;
  /** Docked sheets stay in the page flow (non-modal); modal ones trap focus and dim the page. */
  readonly docked?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Sheet({ open, onClose, label, docked = false, className, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (docked) dialog.show();
      else dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, docked]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      className={cn(
        'w-full max-w-none border-0 bg-paper text-ink',
        docked
          ? 'sticky bottom-0 z-10 m-0 border-t-2 border-ink px-5 pt-4 pb-5.5'
          : 'mx-auto mt-auto mb-0 max-h-[90dvh] max-w-md border-t-2 border-ink px-5 pt-5 pb-6 open:animate-rise',
        className,
      )}
    >
      {children}
    </dialog>
  );
}
