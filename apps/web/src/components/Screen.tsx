import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { ROUTES, spaLink } from '../lib/router';
import { Numeral } from './ui/Numeral';

export function Screen({ children, wide = false, className }: { readonly children: ReactNode; readonly wide?: boolean; readonly className?: string }) {
  return (
    <div className="dot-bg min-h-dvh">
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
      <HomeMark />
    </header>
  );
}

/** The Pialy mark as a link back to the landing page. */
export function HomeMark({ className }: { readonly className?: string }) {
  return (
    <a href={ROUTES.landing} onClick={spaLink(ROUTES.landing)} aria-label="Pialy, ir al inicio" className={cn('-m-3 inline-flex min-h-11 min-w-11 items-center justify-center p-3', className)}>
      <Numeral size="mark" tone="brand" aria-hidden="true">
        pialy
      </Numeral>
    </a>
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
