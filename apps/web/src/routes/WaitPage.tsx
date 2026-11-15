import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, API_PATH, HTTP_NOT_FOUND, STATUS, type BookingView, type QrResponse } from '../api';
import { QrCode } from '../components/QrCode';
import { ErrorNote, Loading, Screen, TopBar } from '../components/Screen';
import { QrIcon } from '../components/icons';
import { Button } from '../components/ui/Button';
import { Numeral } from '../components/ui/Numeral';
import { StatusPill } from '../components/ui/StatusTag';
import { BUSINESS } from '../lib/business';
import { shouldKeepKey, useIdempotencyKey } from '../lib/idempotency';
import { errorDetail, failed, loading, ready, REMOTE, type Remote } from '../lib/remote';
import { navigate, ROUTES, useDocumentTitle } from '../lib/router';
import { formatTime, shortDateLabel } from '../lib/time';
import { useHoldCountdown } from '../lib/useHoldCountdown';
import { isPollTick, useEventStream, type StreamHint } from '../useEventStream';
import { isPaid } from '../ui/status';
import { PassView } from './PassView';

const HOLD_MS = 360_000;
const QR_OFFER_AFTER_MS = 40_000;
const FULL_PERCENT = 100;
const FINE_POINTER = '(pointer: fine)';

function subscribePointer(listener: () => void): () => void {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribePointer, () => window.matchMedia(FINE_POINTER).matches);
}

export function WaitPage({ token }: { readonly token: string }) {
  const [booking, setBooking] = useState<Remote<BookingView>>(loading);

  const latestRequest = useRef(0);

  const inFlight = useRef(false);

  const refetch = useCallback((hint?: StreamHint | null) => {
    // A slow fetch must be able to land: poll ticks never supersede one, SSE-triggered ones may.
    if (isPollTick(hint) && inFlight.current) return;
    inFlight.current = true;
    latestRequest.current += 1;
    const request = latestRequest.current;
    const isStale = (): boolean => request !== latestRequest.current;
    api
      .booking(token)
      .then((data) => {
        if (!isStale()) setBooking(ready(data));
      })
      .catch((error: unknown) => {
        if (!isStale()) setBooking((current) => (current.kind === REMOTE.ready ? current : failed(error)));
      })
      .finally(() => {
        if (!isStale()) inFlight.current = false;
      });
  }, [token]);

  useEffect(() => refetch(), [refetch]);
  useEventStream(API_PATH.bookingEvents(token), refetch);
  useDocumentTitle(waitTitle(booking));

  if (booking.kind === REMOTE.loading) {
    return (
      <Screen>
        <TopBar title={BUSINESS.name} />
        <Loading />
      </Screen>
    );
  }
  if (booking.kind === REMOTE.error) {
    return (
      <Screen>
        <TopBar title={BUSINESS.name} />
        <div className="p-5">
          <ErrorNote>{booking.status === HTTP_NOT_FOUND ? 'No encontramos esa reserva.' : booking.detail}</ErrorNote>
          <Button className="mt-4" onClick={() => navigate(ROUTES.book)}>
            Elegir un horario
          </Button>
        </div>
      </Screen>
    );
  }
  if (isPaid(booking.data.status)) return <PassView booking={booking.data} />;
  if (booking.data.status !== STATUS.holding) return <Released booking={booking.data} />;
  return <Waiting booking={booking.data} />;
}

const TITLE = {
  loading: 'Tu reserva',
  missing: 'Reserva no encontrada',
  pass: 'Tu pase',
  waiting: 'Esperando tu banco',
  released: 'Horario liberado',
} as const;

function waitTitle(booking: Remote<BookingView>): string {
  if (booking.kind === REMOTE.loading) return TITLE.loading;
  if (booking.kind === REMOTE.error) return TITLE.missing;
  if (isPaid(booking.data.status)) return TITLE.pass;
  return booking.data.status === STATUS.holding ? TITLE.waiting : TITLE.released;
}

function Waiting({ booking }: { readonly booking: BookingView }) {
  const countdown = useHoldCountdown(booking.holdExpiresAt);
  const isDesktop = useIsDesktop();
  const elapsedMs = HOLD_MS - countdown.remainingMs;
  const qr = useQrAttempt(booking.token);
  // A QR attempt moves holdExpiresAt later, which shrinks "elapsed": once offered, the QR stays.
  const [qrUnlocked, setQrUnlocked] = useState(false);
  const offerNow = isDesktop || elapsedMs >= QR_OFFER_AFTER_MS;
  useEffect(() => {
    if (offerNow) setQrUnlocked(true);
  }, [offerNow]);
  const offerQr = qrUnlocked || offerNow;
  const time = formatTime(booking.slot.start);
  const barPercent = Math.min(FULL_PERCENT, (countdown.remainingMs / Math.max(HOLD_MS, countdown.remainingMs)) * FULL_PERCENT);
  const qrFirst = offerQr && isDesktop;

  return (
    <Screen>
      <TopBar title={BUSINESS.name} />
      <div className="flex-1 p-5">
        <StatusPill tone="hold" pulse>
          Horario apartado para ti
        </StatusPill>
        <Numeral tone="brand" className="mt-3.5 mb-1.5 block" role="timer" aria-label={`Tiempo restante ${countdown.label}`}>
          {countdown.label}
        </Numeral>
        <p className="mt-1.5 text-base text-muted">
          {shortDateLabel(booking.slot.start)} · <b className="text-ink">{time}</b> · se libera si no autorizas a tiempo.
        </p>
        <div className="mt-2 h-2 border border-brand bg-brand-wash" aria-hidden="true">
          <i className="block h-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${barPercent}%` }} />
        </div>
        {countdown.expired ? (
          <p role="status" className="mt-3 font-bold">
            Estamos confirmando con tu banco antes de liberar el horario.
          </p>
        ) : null}

        {qrFirst ? <QrOffer attempt={qr} /> : null}

        <ol className="mt-5 border-t border-ink">
          <Step n={1} title="Abre la app de tu banco" detail="Te llegó una notificación de cobro CoDi." />
          <Step n={2} title={'Busca "Cobros" o "CoDi"'} detail="En BBVA: Inicio › Notificaciones. Varía por banco." />
          <Step
            n={3}
            title={`Autoriza ${BUSINESS.deposit} a ${BUSINESS.name}`}
            detail="Esta pantalla cambia sola cuando tu banco confirme."
          />
        </ol>

        {offerQr && !qrFirst ? <QrOffer attempt={qr} /> : null}
        {offerQr ? null : (
          <p className="mt-3.5 text-center text-[13px] text-muted">
            Aparece a los 40 s. Si estás en computadora, el QR se muestra primero.
          </p>
        )}
      </div>
    </Screen>
  );
}

function Step({ n, title, detail }: { readonly n: number; readonly title: string; readonly detail: string }) {
  return (
    <li className="grid grid-cols-[40px_1fr] gap-1 border-b border-brand/35 py-3">
      <Numeral size="step" tone="brand" aria-hidden="true">
        {n}
      </Numeral>
      <div>
        <b className="block">{title}</b>
        <span className="text-sm text-muted">{detail}</span>
      </div>
    </li>
  );
}

interface QrAttempt {
  readonly qr: QrResponse | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly request: () => void;
}

function useQrAttempt(token: string): QrAttempt {
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  const request = useCallback(() => {
    setPending(true);
    setError(null);
    api
      .startQr(token, idempotency.keyFor(token))
      .then(setQr)
      .catch((failure: unknown) => {
        if (!shouldKeepKey(failure)) idempotency.reset();
        setError(errorDetail(failure));
      })
      .finally(() => setPending(false));
  }, [token, idempotency]);

  return { qr, pending, error, request };
}

function QrOffer({ attempt }: { readonly attempt: QrAttempt }) {
  const { qr, pending, error, request } = attempt;
  if (qr !== null) {
    return (
      <section aria-label="QR CoDi" className="mt-4 border-2 border-ink p-4">
        <QrCode value={qr.qrString} label="QR CoDi para pagar el anticipo" className="mx-auto size-56 max-w-full" />
        <p className="mt-3 text-center font-bold">Escanéalo con la app de tu banco</p>
        <p className="mt-1 text-center text-sm text-muted">
          Vence a las {formatTime(qr.expiresAt)}. Esta pantalla cambia sola cuando tu banco confirme.
        </p>
      </section>
    );
  }
  return (
    <div className="mt-4">
      <Button variant="ghost" onClick={request} disabled={pending}>
        <QrIcon />
        {pending ? 'Generando QR…' : '¿No te llegó? Pagar con QR CoDi'}
      </Button>
      {error === null ? null : <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function Released({ booking }: { readonly booking: BookingView }) {
  return (
    <Screen>
      <TopBar title={BUSINESS.name} />
      <div className="flex-1 p-5">
        <StatusPill tone="gone">Horario liberado</StatusPill>
        <h1 className="mt-4 text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108%">
          Tu banco no confirmó a tiempo
        </h1>
        <p className="mt-2 text-muted">
          {shortDateLabel(booking.slot.start)} · {formatTime(booking.slot.start)}. Si ya autorizaste el pago, esta pantalla
          cambia sola cuando tu banco confirme; si el horario ya se ocupó, el negocio te devuelve el anticipo por SPEI.
        </p>
        <Button className="mt-5" onClick={() => navigate(ROUTES.book)}>
          Elegir otro horario
        </Button>
      </div>
    </Screen>
  );
}
