import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import type { StatusLook, Tone } from '../../ui/status';

const tag = cva('rounded-full px-2.5 py-1.5 text-[13px] leading-none font-extrabold whitespace-nowrap', {
  variants: {
    tone: {
      hold: 'bg-brand-wash text-brand',
      paid: 'bg-paid-wash text-paid',
      late: 'bg-late-wash text-late',
      free: 'bg-ink/5 text-muted',
      done: 'bg-ink text-paper',
      gone: 'bg-ink/5 text-muted',
    } satisfies Record<Tone, string>,
  },
});

export function StatusTag({ look, className }: { readonly look: StatusLook; readonly className?: string }) {
  return <span className={cn(tag({ tone: look.tone }), className)}>{look.label}</span>;
}

const pill = cva('inline-flex items-center gap-2 rounded-full border-[1.5px] border-current px-2.5 py-1.5 text-sm font-bold', {
  variants: {
    tone: {
      hold: 'text-brand',
      paid: 'text-paid',
      late: 'text-late',
      free: 'text-muted',
      done: 'text-ink',
      gone: 'text-muted',
    } satisfies Record<Tone, string>,
  },
});

export function StatusPill({ tone, pulse = false, children }: { readonly tone: Tone; readonly pulse?: boolean; readonly children: string }) {
  return (
    <span className={pill({ tone })}>
      <span className={cn('size-2.5 rounded-full bg-current', pulse && 'animate-pulse-ring')} aria-hidden="true" />
      {children}
    </span>
  );
}
