import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, HTTP_CONFLICT, HTTP_NOT_FOUND, STATUS, type VerifyView } from '../api';
import { ErrorNote, Loading, Screen, TopBar } from '../components/Screen';
import { Button } from '../components/ui/Button';
import { KeyValues, Label, Panel } from '../components/ui/Panel';
import { BUSINESS } from '../lib/business';
import { redirectIfLoggedOut } from '../lib/owner';
import { errorDetail, failed, loading, ready, REMOTE, type Remote } from '../lib/remote';
import { navigate, ROUTES, useDocumentTitle } from '../lib/router';
import { formatTime } from '../lib/time';
import { bookingLook, isPaid } from '../ui/status';

const ALREADY_CHECKED_IN_TYPE = 'urn:pialy:problem:already-checked-in';
const SINGLE_USE_NOTE = 'Se marca una sola vez; el pago no prueba identidad, así que el negocio confirma el nombre.';

export function VerifyPage({ token }: { readonly token: string }) {
  useDocumentTitle('Verificar pase');
  const [view, setView] = useState<Remote<VerifyView>>(loading);

  const load = useCallback(() => {
    api
      .verify(token)
      .then((data) => setView(ready(data)))
      .catch((error: unknown) => {
        if (!redirectIfLoggedOut(error)) setView(failed(error));
      });
  }, [token]);
  useEffect(load, [load]);

  return (
    <Screen>
      <TopBar title="Verificar pase" />
      {view.kind === REMOTE.loading ? <Loading /> : null}
      {view.kind === REMOTE.error ? (
        <div className="p-5">
          <ErrorNote>{view.status === HTTP_NOT_FOUND ? 'No encontramos ese pase.' : view.detail}</ErrorNote>
        </div>
      ) : null}
      {view.kind === REMOTE.ready ? <Verdict view={view.data} onChange={(next) => setView(ready(next))} /> : null}
      <div className="mt-auto border-t-2 border-ink px-5 pt-3 pb-4.5">
        <Button variant="ghost" size="md" onClick={() => navigate(ROUTES.board)}>
          Volver al tablero
        </Button>
      </div>
    </Screen>
  );
}

function firstUseOf(failure: unknown): string | null {
  if (!(failure instanceof ApiError) || failure.status !== HTTP_CONFLICT) return null;
  if (failure.problem?.['type'] !== ALREADY_CHECKED_IN_TYPE) return null;
  return failure.problem.checkedInAt ?? null;
}

function Verdict({ view, onChange }: { readonly view: VerifyView; readonly onChange: (view: VerifyView) => void }) {
  const [pending, setPending] = useState(false);
  const [reused, setReused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const who = `${view.customerName ?? 'Cliente'} · ${formatTime(view.slotStart)} · ${BUSINESS.service} ${BUSINESS.serviceMinutes} min`;

  async function checkIn() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { checkedInAt } = await api.checkIn(view.token);
      onChange({ ...view, status: STATUS.checkedIn, checkedInAt });
    } catch (failure) {
      if (redirectIfLoggedOut(failure)) return;
      const firstUse = firstUseOf(failure);
      if (firstUse === null) {
        setError(errorDetail(failure));
      } else {
        setReused(firstUse);
        onChange({ ...view, status: STATUS.checkedIn, checkedInAt: firstUse });
      }
    } finally {
      setPending(false);
    }
  }

  if (!isPaid(view.status)) {
    return (
      <div className="p-5">
        <Panel tone="late" as="div" className="px-3.5 py-3">
          <b className="block text-[15px]">Anticipo no confirmado</b>
          <span className="text-sm">
            {who}. Estado: {bookingLook(view.status, view.late).label}. No marques la llegada hasta que el banco confirme.
          </span>
        </Panel>
      </div>
    );
  }

  const usedAt = view.status === STATUS.checkedIn ? view.checkedInAt : null;
  const rows: [string, string][] = [['Anticipo', BUSINESS.depositMxn]];
  if (view.bankName) rows.push(['Banco', view.bankName]);
  rows.push(['Celular', `··${view.phoneLast4}`]);
  rows.push(['Estado de la cita', usedAt === null ? 'Sin usar' : `Usado a las ${formatTime(usedAt)}`]);

  return (
    <>
      <Panel tone="paid" as="div" className="px-5 py-7">
        <Label tone="onPaid">Confirmado por el banco</Label>
        <h1 className="text-[34px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108%">
          {view.late ? 'Anticipo pagado (tardío)' : 'Anticipo pagado'}
        </h1>
        <p className="mt-1.5">{who}</p>
      </Panel>
      <KeyValues rows={rows} className="mx-5 mt-3.5" />
      {usedAt === null ? (
        <div className="px-5">
          <Button className="mt-3.5" onClick={checkIn} disabled={pending}>
            {pending ? 'Marcando…' : 'Marcar que llegó'}
          </Button>
          {error === null ? null : <ErrorNote>{error}</ErrorNote>}
          <p className="mt-3 text-[13px] text-muted">{SINGLE_USE_NOTE}</p>
        </div>
      ) : (
        <Panel tone="note" as="div" role="status" className="mx-5 mt-4 p-3.5">
          <b>
            {reused === null
              ? `Llegada registrada a las ${formatTime(usedAt)}.`
              : `Este pase ya se usó hoy a las ${formatTime(reused)}.`}
          </b>
          <p className="mt-1 text-sm text-muted">{SINGLE_USE_NOTE}</p>
        </Panel>
      )}
    </>
  );
}
