import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Screen, TopBar } from '../components/Screen';
import { Button } from '../components/ui/Button';
import { Field, TextInput } from '../components/ui/Field';
import { errorDetail } from '../lib/remote';
import { navigate, useDocumentTitle } from '../lib/router';

const PIN_MAX_LENGTH = 12;

export function LoginPage({ next }: { readonly next: string }) {
  useDocumentTitle('Entrar al tablero');
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .board()
      .then(() => {
        if (active) navigate(next, { replace: true });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [next]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || pin === '') return;
    setPending(true);
    setError(null);
    try {
      await api.login(pin);
      navigate(next, { replace: true });
    } catch (failure) {
      setError(errorDetail(failure));
      setPin('');
      setPending(false);
    }
  }

  return (
    <Screen>
      <TopBar title="Tablero del negocio" />
      <form onSubmit={submit} className="flex-1 p-5" noValidate>
        <h1 className="text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108%">Entra con tu PIN</h1>
        <p className="mt-1.5 text-base text-muted">Solo para el negocio. La sesión dura 12 horas en este celular.</p>
        <Field label="PIN del negocio" error={error}>
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              aria-invalid={error !== null || undefined}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={PIN_MAX_LENGTH}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              inputClassName="tracking-[0.3em]"
            />
          )}
        </Field>
        <Button type="submit" className="mt-4" disabled={pending || pin === ''}>
          {pending ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </Screen>
  );
}
