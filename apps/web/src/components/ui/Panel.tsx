import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const panel = cva('', {
  variants: {
    tone: {
      paid: 'bg-paid text-paper',
      late: 'rounded-sm border-[1.5px] border-late bg-late-wash text-late',
      note: 'rounded-sm border-2 border-dashed border-ink',
      plain: 'border-t border-ink',
    },
  },
  defaultVariants: { tone: 'plain' },
});

export interface PanelProps extends HTMLAttributes<HTMLElement>, VariantProps<typeof panel> {
  readonly as?: 'section' | 'div' | 'header';
}

export function Panel({ tone, as: Tag = 'section', className, ...props }: PanelProps) {
  return <Tag className={cn(panel({ tone }), className)} {...props} />;
}

const LABEL_TONE = { muted: 'text-muted', onPaid: 'text-paid-wash' } as const;

export function Label({ children, tone = 'muted', className }: { readonly children: ReactNode; readonly tone?: keyof typeof LABEL_TONE; readonly className?: string }) {
  return <span className={cn('text-[13px] font-bold tracking-[0.06em] uppercase', LABEL_TONE[tone], className)}>{children}</span>;
}

export function KeyValues({ rows, className }: { readonly rows: readonly (readonly [string, ReactNode])[]; readonly className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] border-t border-ink', className)}>
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="border-b border-brand/35 py-2.5 pr-4 text-sm text-muted">{key}</dt>
          <dd className="border-b border-brand/35 py-2.5 text-right text-sm font-bold break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
