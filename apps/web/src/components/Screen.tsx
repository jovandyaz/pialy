import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Numeral } from './ui/Numeral';

export function Screen({ children, wide = false, className }: { readonly children: ReactNode; readonly wide?: boolean; readonly className?: string }) {
  return (
    <div className="grid-bg min-h-dvh">
      <main className={cn('mx-auto flex min-h-dvh w-full flex-col bg-paper sm:border-x sm:border-ink', wide ? 'max-w-2xl' : 'max-w-md', className)}>
        {children}
      </main>
    </div>
  );
}

export function TopBar({ title }: { readonly title: string }) {
  return (
    <header className="flex items-center justify-between border-b border-ink px-5 pt-5 pb-3">
      <span className="text-lg font-extrabold font-stretch-105%">{title}</span>
      <Numeral size="mark" tone="brand" aria-label="Pialy">
        pialy
      </Numeral>
    </header>
  );
}

export function ErrorNote({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 rounded-sm border-[1.5px] border-late bg-late-wash px-3.5 py-3 text-sm font-bold text-late">
      {children}
    </p>
  );
}

export function Loading({ label = 'Cargando…' }: { readonly label?: string }) {
  return (
    <p role="status" className="p-5 text-muted">
      {label}
    </p>
  );
}
