import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const numeral = cva('font-display font-black tabular-nums', {
  variants: {
    size: {
      hero: 'text-[96px] leading-[0.85] tracking-tight sm:text-[112px]',
      pass: 'text-[100px] leading-[0.82] tracking-tight sm:text-[120px]',
      sheet: 'text-[44px] leading-none',
      toast: 'text-[28px] leading-none',
      step: 'text-[26px] leading-none',
      mark: 'text-[15px] leading-none',
    },
    tone: { ink: 'text-ink', brand: 'text-brand', inherit: '' },
  },
  defaultVariants: { size: 'hero', tone: 'inherit' },
});

export interface NumeralProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof numeral> {}

export function Numeral({ size, tone, className, ...props }: NumeralProps) {
  return <span className={cn(numeral({ size, tone }), className)} {...props} />;
}
