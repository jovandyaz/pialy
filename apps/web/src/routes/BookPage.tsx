import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, HTTP_CONFLICT, type SlotItem, type SlotState } from '../api';
import { ErrorNote, Screen, TopBar } from '../components/Screen';
import { PhoneIcon } from '../components/icons';
import { Button } from '../components/ui/Button';
import { Field, PhoneInput, TextInput } from '../components/ui/Field';
import { Numeral } from '../components/ui/Numeral';
import { Label } from '../components/ui/Panel';
import { Sheet } from '../components/ui/Sheet';
import { BUSINESS } from '../lib/business';
import { cn } from '../lib/cn';
import { shouldKeepKey, useIdempotencyKey } from '../lib/idempotency';
import { lastHold, rememberHold } from '../lib/last-hold';
import { isCompletePhone, phoneDigits } from '../lib/phone';
import { errorDetail, failed, loading, ready, REMOTE, type Remote } from '../lib/remote';
import { navigate, ROUTES, useDocumentTitle } from '../lib/router';
import { dayOfMonth, formatTime, minutesBetween, nextDays, shortDateLabel, weekdayShort } from '../lib/time';
import { SLOT_LABEL } from '../ui/status';

const DAYS_SHOWN = 5;
const DEFAULT_SERVICE_MINUTES = 45;
const CUSTOMER_NAME_MAX_LENGTH = 80;
const SLOT_TAKEN_TYPE = 'urn:pialy:problem:slot-taken';
const ACTIVE_HOLD_TYPE = 'urn:pialy:problem:active-hold-exists';

type Slots = readonly SlotItem[];

export function BookPage() {
  useDocumentTitle('Aparta tu cita');
  const [days] = useState(() => nextDays(DAYS_SHOWN));
  const [date, setDate] = useState(() => days[0] ?? '');
  const [slots, setSlots] = useState<Remote<Slots>>(loading);
  const [selected, setSelected] = useState<SlotItem | null>(null);
  // Until the customer picks a day, a default day with nothing free skips ahead to the next one that has.
  const autoAdvance = useRef(true);

  const loadSlots = useCallback(
    (day: string, signal?: AbortSignal) => {
      api
        .slots(day, signal)
        .then((data) => {
          if (signal?.aborted) return;
          const nextDay = days[days.indexOf(day) + 1];
          if (autoAdvance.current && nextDay !== undefined && !hasFreeSlot(data.slots)) {
            setDate(nextDay);
            return;
          }
          autoAdvance.current = false;
          setSlots(ready(data.slots));
        })
        .catch((error: unknown) => {
          if (!signal?.aborted) setSlots(failed(error));
        });
    },
    [days],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSlots(loading());
    loadSlots(date, controller.signal);
    return () => controller.abort();
  }, [date, loadSlots]);

  const firstSlot = slots.kind === REMOTE.ready ? slots.data[0] : undefined;
  const serviceMinutes = firstSlot ? minutesBetween(firstSlot.start, firstSlot.end) : DEFAULT_SERVICE_MINUTES;

  return (
    <Screen className="lg:max-w-5xl">
      <TopBar title={BUSINESS.name} />
      <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="dot-bg flex-1 p-5">
          <h1 className="text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108%">Aparta tu cita</h1>
          <p className="mt-1.5 text-base text-muted">Paga un anticipo con CoDi desde tu banco. Sin cuenta, sin tarjeta.</p>
          <div className="flex items-baseline justify-between border-b border-brand/35 py-3.5">
            <b className="text-lg">
              {BUSINESS.service} · {serviceMinutes} min
            </b>
            <span className="font-bold text-brand">Anticipo {BUSINESS.deposit}</span>
          </div>

          <div role="group" aria-label="Día" className="mt-4 mb-1 grid grid-cols-5 border border-ink">
            {days.map((day) => {
              const on = day === date;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    autoAdvance.current = false;
                    setDate(day);
                    setSelected(null);
                  }}
                  className={cn(
                    'cursor-pointer border-r border-ink py-2 text-center text-[13px] font-semibold last:border-r-0',
                    on ? 'bg-ink text-paper' : 'bg-paper',
                  )}
                >
                  {weekdayShort(day)}
                  <span className="block text-[22px] leading-[1.15] font-extrabold tabular-nums">{dayOfMonth(day)}</span>
                </button>
              );
            })}
          </div>

          <SlotGrid state={slots} selected={selected} onSelect={setSelected} onRetry={() => loadSlots(date)} />
        </div>

        <div className="contents lg:block lg:border-l-2 lg:border-ink">
          {selected === null ? (
            <p className="hidden p-5 text-muted lg:block">Elige un horario libre para apartarlo.</p>
          ) : (
            <HoldSheet
              key={selected.start}
              slot={selected}
              onSlotTaken={() => {
                setSelected(null);
                loadSlots(date);
              }}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}

export const hasFreeSlot = (slots: Slots): boolean => slots.some((slot) => slot.state === 'free');

const CELL_LOOK: Readonly<Record<SlotState | 'selected', { cell: string; time: string; sub: string }>> = {
  free: { cell: 'bg-paper', time: '', sub: 'text-muted' },
  held: { cell: 'cursor-not-allowed bg-brand-wash', time: '', sub: 'text-brand' },
  taken: { cell: 'hatched cursor-not-allowed text-gone', time: 'line-through decoration-2', sub: 'text-gone' },
  selected: { cell: 'bg-brand text-paper', time: '', sub: 'text-paper' },
};

function SlotGrid({
  state,
  selected,
  onSelect,
  onRetry,
}: {
  readonly state: Remote<Slots>;
  readonly selected: SlotItem | null;
  readonly onSelect: (slot: SlotItem) => void;
  readonly onRetry: () => void;
}) {
  if (state.kind === REMOTE.loading) {
    return (
      <p role="status" className="mt-4 text-muted">
        Cargando horarios…
      </p>
    );
  }
  if (state.kind === REMOTE.error) {
    return (
      <div className="mt-4">
        <ErrorNote>{state.detail}</ErrorNote>
        <Button variant="ghost" size="md" className="mt-3" onClick={onRetry}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (state.data.length === 0) {
    return <p className="mt-4 border border-ink bg-paper p-4 font-bold">No quedan horarios este día. Elige otro.</p>;
  }
  return (
    <div className="mt-4 grid grid-cols-3 border-t border-l border-ink lg:grid-cols-4">
      {state.data.map((slot) => {
        const isSelected = selected?.start === slot.start;
        const look = CELL_LOOK[isSelected ? 'selected' : slot.state];
        return (
          <button
            key={slot.start}
            type="button"
            disabled={slot.state !== 'free'}
            aria-pressed={isSelected}
            onClick={() => onSelect(slot)}
            className={cn(
              'flex aspect-[1/0.82] cursor-pointer flex-col justify-between border-r border-b border-ink px-2 pt-2 pb-1.5 text-left',
              look.cell,
            )}
          >
            <span
              className={cn(
                'text-2xl leading-[0.95] font-extrabold tracking-[-0.02em] tabular-nums sm:text-[30px] sm:font-stretch-115%',
                look.time,
              )}
            >
              {formatTime(slot.start)}
            </span>
            <span className={cn('text-xs font-semibold', look.sub)}>{SLOT_LABEL[isSelected ? 'selected' : slot.state]}</span>
          </button>
        );
      })}
    </div>
  );
}

const SIDE_PANEL_FROM_LG = 'lg:top-0 lg:bottom-auto lg:max-h-dvh lg:overflow-y-auto lg:border-t-0';

function HoldSheet({ slot, onSlotTaken }: { readonly slot: SlotItem; readonly onSlotTaken: () => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [activeHold, setActiveHold] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!isCompletePhone(phone)) {
      setPhoneError('Revisa tu número: deben ser 10 dígitos');
      return;
    }
    setPhoneError(null);
    setError(null);
    setActiveHold(null);
    setPending(true);
    const customerName = name.trim();
    const body = { slotStart: slot.start, phone: phoneDigits(phone), ...(customerName === '' ? {} : { customerName }) };
    try {
      const hold = await api.hold(body, idempotency.keyFor(JSON.stringify(body)));
      idempotency.reset();
      rememberHold(hold.token);
      navigate(ROUTES.booking(hold.token));
    } catch (failure) {
      setPending(false);
      if (!shouldKeepKey(failure)) idempotency.reset();
      setError(errorDetail(failure));
      const conflict = failure instanceof ApiError && failure.status === HTTP_CONFLICT ? failure.problem?.['type'] : undefined;
      if (conflict === SLOT_TAKEN_TYPE) onSlotTaken();
      // The server never names the other hold (a phone number proves nothing), so only this tab's own can be offered.
      if (conflict === ACTIVE_HOLD_TYPE) setActiveHold(lastHold());
    }
  }

  return (
    <Sheet open docked label="Confirmar horario" className={SIDE_PANEL_FROM_LG}>
      <form onSubmit={submit} noValidate>
        <div className="flex items-baseline justify-between">
          <Label>{shortDateLabel(slot.start)}</Label>
          <Numeral size="sheet">{formatTime(slot.start)}</Numeral>
        </div>
        <Field
          label="Tu celular (ahí te llega la solicitud de pago)"
          hint="Debe estar registrado en CoDi en la app de tu banco. Solo lo usamos para este cobro y guardamos los últimos 4 dígitos."
          error={phoneError}
        >
          {({ inputId, describedBy }) => (
            <PhoneInput id={inputId} value={phone} onChange={setPhone} describedBy={describedBy} invalid={phoneError !== null} />
          )}
        </Field>
        <Field label="Tu nombre (opcional)">
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="given-name"
              maxLength={CUSTOMER_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {error === null ? null : <ErrorNote>{error}</ErrorNote>}
        {activeHold === null ? null : (
          <Button variant="ghost" size="md" className="mt-3" onClick={() => navigate(ROUTES.booking(activeHold))}>
            Ver mi apartado
          </Button>
        )}
        <Button type="submit" className="mt-3.5" disabled={pending}>
          <PhoneIcon />
          {pending ? 'Enviando a tu banco…' : 'Enviar solicitud a mi banco'}
        </Button>
      </form>
    </Sheet>
  );
}
