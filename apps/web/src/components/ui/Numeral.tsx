import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const numeral = cva('font-display font-black tabular-nums', {
  variants: {
    size: {
      hero: 'text-[clamp(96px,96px_+_(112_-_96)_*_(100vw_-_360px)_/_(448_-_360),112px)] leading-[0.85] tracking-tight',
      pass: 'text-[clamp(100px,100px_+_(120_-_100)_*_(100vw_-_360px)_/_(448_-_360),120px)] leading-[0.82] tracking-tight',
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
