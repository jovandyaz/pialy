import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** Shared with links that must look like buttons (e.g. landing CTAs). */
export const buttonClass = cva(
  [
    'inline-flex w-full items-center justify-center gap-2.5 rounded-sm border-2 font-extrabold',
    'cursor-pointer transition-transform duration-100 ease-out active:translate-y-px',
    'disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-5 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        solid: 'border-ink bg-ink text-paper',
        ghost: 'border-ink bg-paper text-ink',
        brand: 'border-brand bg-brand text-paper',
        late: 'border-late bg-paper text-late',
      },
      size: {
        lg: 'min-h-14 px-2 text-lg',
        md: 'min-h-13 px-3 text-base',
        sm: 'min-h-11 px-3 text-sm',
      },
    },
    defaultVariants: { variant: 'solid', size: 'lg' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonClass> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />;
}
