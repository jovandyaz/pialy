import type { ChangeEvent, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import { formatPhoneInput } from '../../lib/phone';

interface FieldProps {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
  readonly className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint === undefined ? null : hintId, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('mt-3', className)}>
      <label htmlFor={inputId} className="text-sm font-bold">
        {label}
      </label>
      {children({ inputId, describedBy })}
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm font-bold text-late">
          {error}
        </p>
      ) : null}
      {hint === undefined ? null : (
        <p id={hintId} className="mt-2 text-[13px] text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

const inputFrame = 'mt-1.5 flex rounded-sm border-2 border-ink bg-paper focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-brand';
const inputBase = 'min-w-0 flex-1 border-0 bg-transparent p-3 text-xl font-semibold tracking-wide outline-none';

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { readonly inputClassName?: string };

export function TextInput({ inputClassName, ...props }: TextInputProps) {
  return (
    <div className={inputFrame}>
      <input className={cn(inputBase, 'text-lg', inputClassName)} {...props} />
    </div>
  );
}

interface PhoneInputProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (formatted: string) => void;
  readonly describedBy: string | undefined;
  readonly invalid?: boolean;
}

export function PhoneInput({ id, value, onChange, describedBy, invalid = false }: PhoneInputProps) {
  return (
    <div className={inputFrame}>
      <span className="border-r-2 border-ink bg-brand-wash p-3 font-bold">+52</span>
      <input
        id={id}
        className={inputBase}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder="55 1234 5678"
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(formatPhoneInput(event.target.value))}
      />
    </div>
  );
}
