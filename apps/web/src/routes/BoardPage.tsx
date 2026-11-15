import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, API_PATH, FLAG_KIND, STATUS, type Board, type BoardSlot, type BookingStatus, type Flag, type OwnerBooking } from '../api';
import { ErrorNote, Loading, Screen } from '../components/Screen';
import { ScanIcon, SoundIcon } from '../components/icons';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Numeral } from '../components/ui/Numeral';
import { Panel } from '../components/ui/Panel';
import { Sheet } from '../components/ui/Sheet';
import { StatusTag } from '../components/ui/StatusTag';
import { depositsTotal } from '../lib/business';
import { cn } from '../lib/cn';
import { redirectIfLoggedOut } from '../lib/owner';
import { errorDetail, failed, loading, ready, REMOTE, type Remote } from '../lib/remote';
import { navigate, ROUTES, useDocumentTitle } from '../lib/router';
import { paymentAnnouncement, speak, speechAvailable } from '../lib/speech';
import { boardDayLabel, formatTime, isoDateOf } from '../lib/time';
import { isPollTick, useEventStream, type StreamHint } from '../useEventStream';
import { bookingLook, FREE_LOOK, flagTitle, isDuplicatePayment, isPaid, needsRefund } from '../ui/status';

const TOAST_MS = 3200;
const FLASH_MS = 1200;
const NOTE_MAX_LENGTH = 500;

interface Toast {
  readonly time: string;
  readonly name: string | null;
}

type StatusSnapshot = ReadonlyMap<string, BookingStatus>;

/** Bookings that became confirmed since the last snapshot; the first snapshot announces nothing. */
export function newlyPaid(previous: StatusSnapshot | null, board: Board): OwnerBooking[] {
  if (previous === null) return [];
  return board.slots.flatMap(({ booking }) => {
    if (booking === null || booking.status !== STATUS.confirmed) return [];
    const before = previous.get(booking.token);
    return before !== undefined && isPaid(before) ? [] : [booking];
  });
}

function snapshot(board: Board): StatusSnapshot {
  return new Map(board.slots.flatMap(({ booking }) => (booking === null ? [] : [[booking.token, booking.status] as const])));
}

export function BoardPage() {
  useDocumentTitle('Tablero');
  const [date, setDate] = useState(() => isoDateOf(new Date()));
  const latestRequest = useRef(0);
  const [board, setBoard] = useState<Remote<Board>>(loading);
  const [soundOn, setSoundOn] = useState(false);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [resolving, setResolving] = useState<Flag | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const seen = useRef<StatusSnapshot | null>(null);
  const soundRef = useRef(soundOn);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);

  const announce = useCallback((paid: readonly OwnerBooking[]) => {
    const last = paid.at(-1);
    if (last === undefined) return;
    setFlashing(new Set(paid.map((b) => b.token)));
    setTimeout(() => setFlashing(new Set()), FLASH_MS);
    setToast({ time: formatTime(last.slotStart), name: last.customerName });
    setTimeout(() => setToast(null), TOAST_MS);
    if (soundRef.current) for (const booking of paid) speak(paymentAnnouncement(formatTime(booking.slotStart)));
  }, []);

  const inFlight = useRef(false);

  const refetch = useCallback(
    (hint?: StreamHint | null) => {
    // A slow fetch must be able to land: poll ticks never supersede one, SSE-triggered ones may.
    if (isPollTick(hint) && inFlight.current) return;
    inFlight.current = true;
    latestRequest.current += 1;
    const request = latestRequest.current;
    const isStale = (): boolean => request !== latestRequest.current;
    // Computed per fetch so the board rolls over at midnight in the business time zone.
    const today = isoDateOf(new Date());
    api
      .board(today)
      .then((data) => {
        if (isStale()) return;
        setDate(today);
        announce(newlyPaid(seen.current, data));
        seen.current = snapshot(data);
        setBoard(ready(data));
      })
      .catch((error: unknown) => {
        if (isStale() || redirectIfLoggedOut(error)) return;
        setBoard((current) => (current.kind === REMOTE.ready ? current : failed(error)));
      })
      .finally(() => {
        if (!isStale()) inFlight.current = false;
      });
    },
    [announce],
  );

  useEffect(() => refetch(), [refetch]);
  useEventStream(board.kind === REMOTE.ready ? API_PATH.boardEvents : null, refetch);

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    if (next) speak('Sonido activado');
    else if (speechAvailable()) window.speechSynthesis.cancel();
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    navigate(ROUTES.login, { replace: true });
  }

  const data = board.kind === REMOTE.ready ? board.data : null;
  const bookings = data?.slots.flatMap((slot) => (slot.booking === null ? [] : [slot.booking])) ?? [];
  const paidCount = bookings.filter((b) => isPaid(b.status)).length;
  const holdingCount = bookings.filter((b) => b.status === STATUS.holding).length;

  return (
    <Screen wide>
      <header className="border-b-2 border-ink px-5 pt-4.5 pb-3.5">
        <div className="flex items-center justify-between gap-2.5">
          <h1 className="text-lg font-extrabold font-stretch-105%">Hoy · {boardDayLabel(date)}</h1>
          <button
            type="button"
            aria-pressed={soundOn}
            onClick={toggleSound}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-ink px-3.5 text-[15px] font-extrabold [&_svg]:size-4.5',
              soundOn ? 'bg-ink text-paper' : 'bg-paper',
            )}
          >
            <SoundIcon />
            <span>{soundOn ? 'Sonido activo' : 'Activar sonido'}</span>
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4.5 gap-y-1 text-sm text-muted">
          <span>
            <b className="text-base text-ink">{paidCount}</b> confirmadas
          </span>
          <span>
            <b className="text-base text-ink">{holdingCount}</b> apartando
          </span>
          <span>
            <b className="text-base text-ink">{depositsTotal(paidCount)}</b> en anticipos
          </span>
          <button type="button" onClick={logout} className="ml-auto cursor-pointer font-bold text-ink underline underline-offset-2">
            Salir
          </button>
        </div>
      </header>

      {board.kind === REMOTE.loading ? <Loading label="Cargando tablero…" /> : null}
      {board.kind === REMOTE.error ? (
        <div className="p-5">
          <ErrorNote>{board.detail}</ErrorNote>
          <Button variant="ghost" size="md" className="mt-3" onClick={() => refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}

      {data === null ? null : (
        <>
          {data.flags.map((flag) => (
            <FlagAlert key={flag.id} flag={flag} onResolve={() => {
                setResolving(flag);
                setResolveOpen(true);
              }} />
          ))}
          <ol aria-label="Agenda" className="mx-5 mt-3.5 mb-6 border-t border-ink">
            {data.slots.map((slot) => (
              <AgendaRow key={slot.start} slot={slot} flash={slot.booking !== null && flashing.has(slot.booking.token)} />
            ))}
          </ol>
        </>
      )}

      <div className="sticky bottom-0 z-10 mt-auto border-t-2 border-ink bg-paper px-5 pt-3 pb-4.5">
        <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-4 bottom-full mb-3">
          {toast === null ? null : (
            <div className="flex animate-rise items-center gap-3 rounded-sm bg-paid px-4 py-3.5 font-bold text-paper">
              <Numeral size="toast">{toast.time}</Numeral>
              <span>{toast.name === null ? 'Anticipo recibido' : `Anticipo recibido de ${toast.name}`}</span>
            </div>
          )}
        </div>
        <Button variant="ghost" size="md" onClick={() => setScanOpen(true)}>
          <ScanIcon />
          Escanear pase
        </Button>
      </div>

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} label="Escanear pase">
        <h2 className="text-2xl font-extrabold">Escanear pase</h2>
        <p className="mt-2">Abre la cámara de tu celular y apunta al QR del pase del cliente. Se abre la verificación aquí mismo.</p>
        <Button className="mt-4" onClick={() => setScanOpen(false)}>
          Entendido
        </Button>
      </Sheet>

      {resolving === null ? null : (
        <ResolveSheet
          key={resolving.id}
          flag={resolving}
          open={resolveOpen}
          onDone={() => {
            setResolveOpen(false);
            refetch();
          }}
          onCancel={() => setResolveOpen(false)}
        />
      )}
    </Screen>
  );
}

function AgendaRow({ slot, flash }: { readonly slot: BoardSlot; readonly flash: boolean }) {
  const booking = slot.booking;
  const look = booking === null ? FREE_LOOK : bookingLook(booking.status, booking.late);
  return (
    <li className="relative isolate grid grid-cols-[64px_1fr_auto] items-center gap-2.5 border-b border-brand/35 py-3 sm:grid-cols-[76px_1fr_auto]">
      {flash ? <span aria-hidden="true" className="absolute inset-y-0 -right-5 -left-5 -z-10 animate-sweep bg-paid-wash" /> : null}
      <span className="text-[22px] leading-none font-extrabold tracking-[-0.02em] tabular-nums sm:text-[26px] sm:font-stretch-112%">
        {formatTime(slot.start)}
      </span>
      <div className="min-w-0">
        <b className="block truncate text-base">{booking === null ? '—' : (booking.customerName ?? 'Sin nombre')}</b>
        <span className="text-[13px] text-muted">{rowDetail(booking)}</span>
      </div>
      <StatusTag look={look} />
    </li>
  );
}

function rowDetail(booking: OwnerBooking | null): string {
  if (booking === null) return 'Disponible';
  if (booking.status === STATUS.holding) return 'Esperando su banco';
  if (booking.status === STATUS.checkedIn && booking.checkedInAt !== null) return `Pase usado ${formatTime(booking.checkedInAt)}`;
  return [`Cel. ··${booking.phoneLast4}`, booking.bankName].filter(Boolean).join(' · ');
}

function flagDetail(flag: Flag): string {
  const who = flag.booking?.customerName ?? 'Alguien';
  const paidAt = flag.paidAt === null || Number.isNaN(Date.parse(flag.paidAt)) ? '' : ` a las ${formatTime(flag.paidAt)}`;
  const slotTime = flag.booking === null ? null : formatTime(flag.booking.slotStart);
  const tracking = flag.trackingKey === null ? '' : ` Clave de rastreo ${flag.trackingKey}.`;
  if (isDuplicatePayment(flag)) return `${who} pagó otra vez${paidAt} su cita de las ${slotTime ?? '—'}.${tracking}`;
  if (flag.kind === FLAG_KIND.refundDue && slotTime !== null) {
    return `${who} pagó${paidAt} pero su horario de las ${slotTime} ya se había liberado y lo tomó otra persona.${tracking}`;
  }
  if (flag.kind === FLAG_KIND.unmatchedPayment) return `Llegó un pago${paidAt} que no corresponde a ninguna cita.${tracking}`;
  return `Revisa este pago${paidAt} en tu banco.${tracking}`;
}

function flagAction(flag: Flag): string {
  return needsRefund(flag) ? 'Registrar devolución SPEI' : 'Marcar como revisado';
}

function FlagAlert({ flag, onResolve }: { readonly flag: Flag; readonly onResolve: () => void }) {
  return (
    <Panel tone="late" as="div" role="status" className="mx-5 mt-3.5 px-3.5 py-3 text-sm">
      <b className="block text-[15px]">{flagTitle(flag)}</b>
      <span className="text-ink">{flagDetail(flag)}</span>
      <Button variant="late" size="sm" className="mt-2.5" onClick={onResolve}>
        {flagAction(flag)}
      </Button>
    </Panel>
  );
}

interface ResolveSheetProps {
  readonly flag: Flag;
  readonly open: boolean;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

function ResolveSheet({ flag, open, onDone, onCancel }: ResolveSheetProps) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = flagAction(flag);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = note.trim();
    if (pending || trimmed === '') return;
    setPending(true);
    setError(null);
    try {
      await api.resolveFlag(flag.id, trimmed);
      onDone();
    } catch (failure) {
      if (redirectIfLoggedOut(failure)) return;
      setError(errorDetail(failure));
      setPending(false);
    }
  }

  return (
    <Sheet open={open} onClose={onCancel} label={title}>
      <form onSubmit={submit}>
        <h2 className="text-2xl font-extrabold">{title}</h2>
        <p className="mt-1.5 text-sm text-muted">
          {needsRefund(flag) ? 'Haz la transferencia desde tu banco y anota aquí la clave de rastreo SPEI.' : 'Anota qué revisaste.'}
        </p>
        <Field label="Nota" error={error}>
          {({ inputId, describedBy }) => (
            <textarea
              id={inputId}
              aria-describedby={describedBy}
              required
              maxLength={NOTE_MAX_LENGTH}
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1.5 block w-full rounded-sm border-2 border-ink p-3 text-base"
            />
          )}
        </Field>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="submit" size="md" disabled={pending || note.trim() === ''}>
            {pending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
