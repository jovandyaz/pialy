/**
 * THESIS: the page IS a live appointment slot; the hero flips a slot free → "Alguien paga" (06:00) → "Anticipo pagado".
 * Refuses: centered hero, feature-card grid, fake testimonials.
 * OWN-WORLD: cobalt-on-white agenda grid paper, Doto numerals for times and amounts, hatched taken slots,
 * green paid stamp, amber late tag; 1px rules; 2px corners. Only theme.css tokens.
 * STORY: no-show cost → CoDi deposit to the bank app → hold lives 6 min, bank confirms → owner hears it,
 * door scans the pass → edge cases handled → try it now. FORM: "live slot". FINISH: review, verdict, DESIGN.md.
 */
import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { STATUS } from '../api';
import { QrCode } from '../components/QrCode';
import { buttonClass } from '../components/ui/Button';
import { Numeral } from '../components/ui/Numeral';
import { KeyValues, Label, Panel } from '../components/ui/Panel';
import { StatusPill, StatusTag } from '../components/ui/StatusTag';
import { BUSINESS } from '../lib/business';
import { cn } from '../lib/cn';
import { navigate, ROUTES } from '../lib/router';
import { formatCountdown } from '../lib/useHoldCountdown';
import { HOLD_SECONDS, LOOP_PHASE, PAID_LOOP, useSlotLoop, type SlotLoop } from '../lib/useSlotLoop';
import { bookingLook, FREE_LOOK, type StatusLook } from '../ui/status';

const LANDING_TITLE = 'Pialy · Anticipos con CoDi para apartar citas';
const REPO_URL = 'https://github.com/jovandyaz/pialy';
const MS_PER_SECOND = 1000;
const PERCENT = 100;
const EXAMPLE_QR_VALUE = 'Pialy · pase de ejemplo';

const EXAMPLE = {
  day: 'Sáb 15 nov',
  boardDay: 'sáb 15',
  time: '11:15',
  customer: 'Jorge P.',
  bank: 'BBVA',
  phoneLast4: '5678',
  reusedAt: '11:12',
} as const;

const LATE_REFUND: StatusLook = { tone: 'late', label: 'Devolución pendiente' };

export function LandingPage() {
  useEffect(() => {
    document.title = LANDING_TITLE;
  }, []);
  const loop = useSlotLoop();

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <SiteHeader />
      <main>
        <Hero loop={loop} />
        <HowItWorks />
        <TwoScreens />
        <HardCases />
        <Proof />
        <Close />
      </main>
      <SiteFooter />
    </div>
  );
}

function spaLink(to: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
}

function DemoCta({ className, children = 'Probar la demo · $0.01' }: { readonly className?: string; readonly children?: ReactNode }) {
  return (
    <a href={ROUTES.book} onClick={spaLink(ROUTES.book)} className={cn(buttonClass({ variant: 'brand' }), className)}>
      {children}
    </a>
  );
}

const shell = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-10';
const textLink = 'inline-flex min-h-11 items-center font-bold underline decoration-2 underline-offset-4';

function SiteHeader() {
  return (
    <header className="border-b border-ink bg-paper">
      <div className={cn(shell, 'flex min-h-15 items-center justify-between gap-4')}>
        <a href={ROUTES.landing} aria-label="Pialy, inicio" className="inline-flex min-h-11 items-center">
          <Numeral size="sheet" tone="brand" className="text-[32px] leading-none">
            pialy
          </Numeral>
        </a>
        <a href={ROUTES.board} onClick={spaLink(ROUTES.board)} className={cn(textLink, 'text-[15px]')}>
          Tablero del negocio
        </a>
      </div>
    </header>
  );
}

function Hero({ loop }: { readonly loop: SlotLoop }) {
  return (
    <section aria-labelledby="hero-title" className="grid-bg border-b border-ink">
      <div className={cn(shell, 'grid gap-8 pt-5 pb-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-14 lg:py-20')}>
        <div className="max-w-xl">
          <Label className="text-brand">Tu lugar, guardado al instante</Label>
          <h1
            id="hero-title"
            className="mt-2 text-[34px] leading-[1.02] font-extrabold tracking-[-0.025em] font-stretch-110% sm:text-5xl lg:text-[52px]"
          >
            Anticipos con CoDi para apartar citas.
          </h1>
          <p className="mt-3 max-w-[46ch] text-[17px] text-muted lg:text-xl">
            Sin tarjeta, sin comisión. Tu cliente paga desde la app de su banco y el horario queda apartado.
          </p>
          <LiveSlotCard loop={loop} className="mt-5 lg:hidden" />
          <div className="mt-5 flex flex-col gap-2 sm:max-w-sm lg:mt-8">
            <DemoCta />
            <a href={ROUTES.board} onClick={spaLink(ROUTES.board)} className={cn(textLink, 'justify-center gap-1.5 text-[15px] sm:justify-start')}>
              Ver el tablero del negocio <span className="font-semibold text-muted no-underline">(pide PIN)</span>
            </a>
          </div>
        </div>
        <PhonePair loop={loop} />
      </div>
    </section>
  );
}

const SLOT_LOOK = {
  free: { cell: 'bg-paper', label: 'Libre' },
  held: { cell: 'bg-brand-wash', label: 'Alguien paga' },
  paid: { cell: 'bg-paid text-paper', label: 'Anticipo pagado' },
} as const;

function holdPercent(loop: SlotLoop): number {
  return loop.phase === LOOP_PHASE.held ? (loop.remainingSeconds / HOLD_SECONDS) * PERCENT : PERCENT;
}

function LiveSlotCard({ loop, className }: { readonly loop: SlotLoop; readonly className?: string }) {
  const look = SLOT_LOOK[loop.phase];
  return (
    <figure className={cn('border border-ink bg-paper', className)}>
      <figcaption className="flex items-center justify-between border-b border-ink px-3 py-2">
        <Label>Ejemplo · {EXAMPLE.day}</Label>
        <span className="sr-only">
          El horario de las {EXAMPLE.time} pasa de libre a «alguien paga», con 6 minutos para pagar, y a «anticipo pagado» cuando
          el banco confirma.
        </span>
        <span aria-hidden="true" className="text-[13px] font-bold">
          {BUSINESS.name}
        </span>
      </figcaption>
      <div aria-hidden="true">
        <div className="grid grid-cols-3">
          <MiniCell time="09:45" taken />
          <MiniCell time="10:30" />
          <MiniCell time="12:00" taken last />
        </div>
        <div className={cn('grid h-44 grid-rows-[1fr_auto] border-t border-ink p-3 transition-colors duration-300', look.cell)}>
          <div className="flex items-start justify-between gap-3">
            <Numeral size="sheet" className="text-[76px] leading-[0.85] tracking-tight">{EXAMPLE.time}</Numeral>
            {loop.phase === LOOP_PHASE.held ? (
              <Numeral size="sheet" tone="brand" className="text-[34px] leading-none">
                {formatCountdown(loop.remainingSeconds * MS_PER_SECOND)}
              </Numeral>
            ) : null}
          </div>
          {loop.phase === LOOP_PHASE.paid ? (
            <div key={loop.cycle} className="flex animate-rise items-end justify-between gap-3">
              <span className="-rotate-2 rounded-sm border-2 border-paper px-2 py-1 text-[15px] font-extrabold tracking-[0.06em] whitespace-nowrap uppercase">
                {look.label}
              </span>
              <span className="text-right text-[13px] leading-tight font-bold text-paid-wash">
                <Numeral size="sheet" className="block text-[26px] text-paper">{BUSINESS.deposit}</Numeral>
                lo confirmó el banco
              </span>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <span className={cn('text-[15px] font-bold', loop.phase === LOOP_PHASE.held ? 'text-brand' : 'text-muted')}>{look.label}</span>
                <span className="text-[13px] font-semibold text-muted">
                  {BUSINESS.service} · {BUSINESS.serviceMinutes} min
                </span>
              </div>
              <HoldBar percent={holdPercent(loop)} />
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}

function HoldBar({ percent }: { readonly percent: number }) {
  return (
    <div className="mt-2 h-2 border border-brand bg-brand-wash">
      <i className="block h-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${percent}%` }} />
    </div>
  );
}

function MiniCell({ time, taken = false, last = false }: { readonly time: string; readonly taken?: boolean; readonly last?: boolean }) {
  return (
    <div className={cn('flex h-15 flex-col justify-between px-2 pt-1.5 pb-1', !last && 'border-r border-ink', taken ? 'hatched text-gone' : 'bg-paper')}>
      <Numeral size="sheet" className={cn('text-[22px] leading-none', taken && 'line-through decoration-2')}>{time}</Numeral>
      <span className={cn('text-xs font-semibold', taken ? 'text-gone' : 'text-muted')}>{taken ? 'Ocupado' : 'Libre'}</span>
    </div>
  );
}

function PhonePair({ loop }: { readonly loop: SlotLoop }) {
  return (
    <figure className="hidden lg:block">
      <figcaption className="mb-3">
        <Label>Ejemplo · el mismo pago en los dos celulares</Label>
      </figcaption>
      <div aria-hidden="true" className="grid grid-cols-[300px_340px] items-start gap-6">
        <CustomerPhone loop={loop} />
        <OwnerBoard loop={loop} />
      </div>
    </figure>
  );
}

function Device({ caption, children }: { readonly caption: string; readonly children: ReactNode }) {
  return (
    <div>
      <div className="flex flex-col overflow-hidden rounded-sm border-2 border-ink bg-paper">{children}</div>
      <p className="mt-2 text-[13px] font-bold text-muted">{caption}</p>
    </div>
  );
}

function PassHeader() {
  return (
    <Panel as="div" tone="paid" className="px-4 py-3.5">
      <Label tone="onPaid" className="text-[11px]">
        Anticipo confirmado por tu banco
      </Label>
      <b className="mt-0.5 block text-xl font-extrabold">{BUSINESS.name}</b>
    </Panel>
  );
}

function PassTime() {
  return (
    <>
      <Numeral size="sheet" className="block px-4 pt-3 text-[80px] leading-[0.85] tracking-tight">{EXAMPLE.time}</Numeral>
      <p className="px-4 pt-1 text-sm font-bold">
        {EXAMPLE.day} · {BUSINESS.service} {BUSINESS.serviceMinutes} min
      </p>
    </>
  );
}

function CustomerPhone({ loop }: { readonly loop: SlotLoop }) {
  if (loop.phase === LOOP_PHASE.paid) {
    return (
      <Device caption="Cliente · su celular">
        <div key={loop.cycle} className="h-[392px] animate-rise">
          <PassHeader />
          <PassTime />
          <QrCode value={EXAMPLE_QR_VALUE} label="QR ilustrativo" className="mx-auto mt-3 size-32" />
          <p className="text-center text-[11px] text-gone">QR ilustrativo</p>
        </div>
      </Device>
    );
  }
  return (
    <Device caption="Cliente · su celular">
      <div className="h-[392px]">
        <div className="flex items-center justify-between border-b border-ink px-4 pt-3.5 pb-2.5">
          <span className="text-[15px] font-extrabold font-stretch-105%">{BUSINESS.name}</span>
          <Numeral size="mark" tone="brand">
            pialy
          </Numeral>
        </div>
        <div className="p-4">
          <StatusPill tone="hold" pulse>
            Horario apartado para ti
          </StatusPill>
          <Numeral size="sheet" tone="brand" className="mt-3 block text-[60px] leading-[0.85] tracking-tight">
            {formatCountdown(loop.remainingSeconds * MS_PER_SECOND)}
          </Numeral>
          <p className="mt-2 text-sm text-muted">
            {EXAMPLE.day} · <b className="text-ink">{EXAMPLE.time}</b> · se libera si no autorizas a tiempo.
          </p>
          <HoldBar percent={holdPercent(loop)} />
          <ol className="mt-4 border-t border-ink text-sm">
            <li className="border-b border-brand/35 py-2">
              <b>1.</b> Abre la app de tu banco
            </li>
            <li className="border-b border-brand/35 py-2">
              <b>2.</b> Busca «Cobros» o «CoDi»
            </li>
            <li className="border-b border-brand/35 py-2">
              <b>3.</b> Autoriza {BUSINESS.deposit}
            </li>
          </ol>
        </div>
      </div>
    </Device>
  );
}

interface ExampleRow {
  readonly time: string;
  readonly name: string;
  readonly detail: string;
  readonly look: StatusLook;
}

const PAID_LOOK = bookingLook(STATUS.confirmed, false);
const EMPTY_ROW = { name: '—', detail: 'Disponible', look: FREE_LOOK } as const;

const BOARD_BEFORE: readonly ExampleRow[] = [
  { time: '09:00', name: 'Ana R.', detail: 'Pase usado 09:02', look: bookingLook(STATUS.checkedIn, false) },
  { time: '09:45', name: 'María G.', detail: 'Banorte · ··0912', look: PAID_LOOK },
];

function liveRow(loop: SlotLoop): ExampleRow {
  if (loop.phase === LOOP_PHASE.free) return { time: EXAMPLE.time, ...EMPTY_ROW };
  if (loop.phase === LOOP_PHASE.held) {
    return { time: EXAMPLE.time, name: EXAMPLE.customer, detail: 'Esperando su banco', look: bookingLook(STATUS.holding, false) };
  }
  return { time: EXAMPLE.time, name: EXAMPLE.customer, detail: `${EXAMPLE.bank} · ··${EXAMPLE.phoneLast4}`, look: PAID_LOOK };
}

function OwnerBoard({ loop }: { readonly loop: SlotLoop }) {
  const paid = loop.phase === LOOP_PHASE.paid;
  const paidCount = BOARD_BEFORE.length + (paid ? 1 : 0);
  return (
    <Device caption="Negocio · el tablero">
      <div className="relative flex h-[392px] flex-col">
        <div className="border-b-2 border-ink px-4 pt-3.5 pb-3">
          <b className="text-base font-extrabold font-stretch-105%">Hoy · {EXAMPLE.boardDay}</b>
          <div className="mt-1.5 flex gap-4 text-[13px] text-muted">
            <span>
              <b className="text-[15px] text-ink">{paidCount}</b> confirmadas
            </span>
            <span>
              <b className="text-[15px] text-ink">{loop.phase === LOOP_PHASE.held ? 1 : 0}</b> apartando
            </span>
          </div>
        </div>
        <ol className="mx-4 mt-2 border-t border-ink">
          {BOARD_BEFORE.map((row) => (
            <BoardRow key={row.time} row={row} />
          ))}
          <BoardRow row={liveRow(loop)} flashKey={paid ? loop.cycle : null} />
        </ol>
        {paid ? (
          <div key={loop.cycle} className="absolute inset-x-3 bottom-3 flex animate-rise items-center gap-3 rounded-sm bg-paid px-3.5 py-3 font-bold text-paper">
            <Numeral size="toast">{EXAMPLE.time}</Numeral>
            <span className="text-sm leading-tight">Anticipo recibido de {EXAMPLE.customer}</span>
          </div>
        ) : null}
      </div>
    </Device>
  );
}

function BoardRow({ row, flashKey = null }: { readonly row: ExampleRow; readonly flashKey?: number | null }) {
  return (
    <li className="relative isolate grid grid-cols-[52px_1fr_auto] items-center gap-2 border-b border-brand/35 py-2.5">
      {flashKey === null ? null : (
        <span key={flashKey} aria-hidden="true" className="absolute inset-y-0 -right-4 -left-4 -z-10 animate-sweep bg-paid-wash" />
      )}
      <span className="text-lg leading-none font-extrabold tracking-[-0.02em] tabular-nums">{row.time}</span>
      <div className="min-w-0">
        <b className="block truncate text-sm">{row.name}</b>
        <span className="text-xs text-muted">{row.detail}</span>
      </div>
      <StatusTag look={row.look} className="text-xs" />
    </li>
  );
}

function SectionHeading({ id, eyebrow, children }: { readonly id: string; readonly eyebrow: string; readonly children: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <Label className="text-brand">{eyebrow}</Label>
      <h2 id={id} className="mt-1.5 text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108% lg:text-[40px]">
        {children}
      </h2>
    </div>
  );
}

const STEPS = [
  {
    at: '00:00',
    title: 'La solicitud llega a su banco',
    body: 'Tu cliente elige horario y escribe su celular. Le llega un cobro CoDi® en la app de su banco y el horario queda apartado.',
  },
  {
    at: '00:40',
    title: 'Si no llegó, un QR',
    body: 'Si la notificación no aparece, la pantalla ofrece un QR CoDi para escanear con la misma app. Nunca se queda esperando sin salida.',
  },
  {
    at: '06:00',
    title: 'Si no paga, se libera',
    body: 'El apartado dura lo que vive la solicitud del banco. Al vencer, el horario vuelve a estar libre para alguien más.',
  },
] as const;

function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="grid-bg border-b border-ink">
      <div className={cn(shell, 'py-12 lg:py-20')}>
        <SectionHeading id="how-title" eyebrow="Cómo funciona">
          Una cita que no llega es una hora que ya no vendes.
        </SectionHeading>
        <p className="mt-3 max-w-[60ch] text-muted">
          Pialy pide un anticipo por CoDi® directo a la app del banco de tu cliente: sin tarjeta, sin comisión y sin instalar nada. El
          horario se confirma solo cuando el banco confirma.
        </p>
        <ol className="mt-8 border-l-2 border-ink lg:grid lg:grid-cols-3 lg:border-t-2 lg:border-l-0">
          {STEPS.map((step) => (
            <li key={step.at} className="relative bg-paper py-5 pr-4 pl-5 lg:border-r lg:border-ink lg:px-6 lg:py-6 lg:last:border-r-0">
              <span aria-hidden="true" className="absolute top-7 -left-[7px] size-3 bg-brand lg:-top-[7px] lg:left-6" />
              <Numeral size="sheet" tone="brand" className="block text-[44px] leading-none lg:text-[56px]">
                {step.at}
              </Numeral>
              <h3 className="mt-2 text-lg font-extrabold">{step.title}</h3>
              <p className="mt-1 text-[15px] text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function TwoScreens() {
  return (
    <section aria-labelledby="screens-title" className="border-b border-ink">
      <div className={cn(shell, 'grid gap-8 py-12 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-14 lg:py-20')}>
        <div className="max-w-xl">
          <SectionHeading id="screens-title" eyebrow="Cuando el banco confirma">
            El negocio oye «Anticipo recibido». En la puerta, se escanea el pase.
          </SectionHeading>
          <ul className="mt-5 border-t border-ink">
            <Point title="El dueño se entera sin mirar">El renglón se pinta de verde y el tablero lo dice en voz alta.</Point>
            <Point title="El cliente recibe su pase">Con la hora, el banco y los últimos dígitos de su celular. Sin cuenta, sin app.</Point>
            <Point title="En la puerta se escanea una vez">El pase confirma el pago de la cita, no la identidad.</Point>
          </ul>
        </div>
        <div role="group" aria-label="Ejemplo de las dos pantallas" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-[340px_300px]">
          <div>
            <Label className="mb-2 block">Ejemplo</Label>
            <OwnerBoard loop={PAID_LOOP} />
          </div>
          <div>
            <Label className="mb-2 block">Ejemplo</Label>
            <Device caption="Cliente · su pase">
              <PassHeader />
              <PassTime />
              <QrCode value={EXAMPLE_QR_VALUE} label="QR ilustrativo del pase" className="mx-auto mt-3 size-28" />
              <KeyValues
                className="mx-4 mt-2 mb-3"
                rows={[
                  ['Anticipo', BUSINESS.depositMxn],
                  ['Banco', EXAMPLE.bank],
                  ['Celular', `··${EXAMPLE.phoneLast4}`],
                ]}
              />
            </Device>
          </div>
        </div>
      </div>
    </section>
  );
}

function Point({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <li className="border-b border-brand/35 py-3">
      <b className="block">{title}</b>
      <span className="text-[15px] text-muted">{children}</span>
    </li>
  );
}

const CASES: readonly { readonly look: StatusLook; readonly title: string; readonly body: string }[] = [
  {
    look: bookingLook(STATUS.confirmed, true),
    title: 'Pago tardío',
    body: 'Si el banco confirma después de los 6 minutos y el horario sigue libre, la cita se confirma marcada como tardía.',
  },
  {
    look: LATE_REFUND,
    title: 'Pago repetido o sobre un horario ya ocupado',
    body: 'El tablero lo marca con devolución pendiente para regresarlo por SPEI. No se pierde ni se cuenta dos veces.',
  },
  {
    look: bookingLook(STATUS.expired, false),
    title: 'Apartado vencido',
    body: 'Antes de liberar el horario, Pialy le pregunta al banco si el pago llegó.',
  },
  {
    look: bookingLook(STATUS.checkedIn, false),
    title: 'Pase usado dos veces',
    body: `La segunda lectura se rechaza y dice cuándo se usó: «Este pase ya se usó hoy a las ${EXAMPLE.reusedAt}».`,
  },
];

function HardCases() {
  return (
    <section aria-labelledby="cases-title" className="border-b border-ink">
      <div className={cn(shell, 'py-12 lg:py-20')}>
        <SectionHeading id="cases-title" eyebrow="Casos límite">
          Lo difícil ya está resuelto.
        </SectionHeading>
        <ul className="mt-6 border-t border-ink">
          {CASES.map((item) => (
            <li
              key={item.title}
              className="grid gap-x-6 gap-y-1.5 border-b border-brand/35 py-4 sm:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_320px_minmax(0,1fr)] lg:items-baseline"
            >
              <span>
                <StatusTag look={item.look} />
              </span>
              <b className="text-[17px]">{item.title}</b>
              <span className="text-[15px] text-muted sm:col-start-2 lg:col-start-auto">{item.body}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Proof() {
  return (
    <section aria-label="Prueba" className="border-b-2 border-ink bg-paid-wash">
      <div className={cn(shell, 'grid gap-4 py-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-10')}>
        <span className="w-fit -rotate-2 rounded-sm border-2 border-paid px-2.5 py-1 text-[15px] font-extrabold tracking-[0.06em] text-paid uppercase">
          Probado
        </span>
        <div>
          <p className="text-lg font-bold lg:text-xl">
            Probado con pagos reales de <Numeral size="sheet" className="text-[1.15em]">$0.01</Numeral>: solicitud al celular y QR CoDi, confirmados
            por el banco (BBVA).
          </p>
          <p className="mt-1.5 font-semibold">El pago se confirma solo con el banco: nunca desde el navegador.</p>
          <p className="mt-2 text-[13px] text-muted">
            Nota técnica: cobro con CoDi® vía pey; la confirmación llega por webhook firmado o consulta de estado.
          </p>
        </div>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section aria-labelledby="close-title" className="grid-bg">
      <div className={cn(shell, 'py-14 lg:py-24')}>
        <div className="max-w-2xl border border-ink bg-paper p-5 lg:p-10">
          <Numeral size="sheet" tone="brand" className="block text-[112px] leading-[0.82] tracking-tight lg:text-[176px]">
            {BUSINESS.deposit}
          </Numeral>
          <h2 id="close-title" className="mt-4 text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108% lg:text-[40px]">
            Pruébalo con tu propio banco.
          </h2>
          <p className="mt-2 text-muted">Aparta un horario en el {BUSINESS.name} y mira cómo cambia la pantalla cuando tu banco confirma.</p>
          <DemoCta className="mt-5 sm:max-w-sm">Probar la demo</DemoCta>
          <p className="mt-3 text-[13px] text-muted">Pagas $0.01 real desde tu banco. Es una demo; el monto no se devuelve.</p>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-ink">
      <div className={cn(shell, 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5 text-sm')}>
        <Numeral size="mark" tone="brand" className="text-lg">
          pialy
        </Numeral>
        <a href={REPO_URL} className={textLink}>
          Código en GitHub
        </a>
        <span className="text-muted">Hecho en CDMX</span>
      </div>
    </footer>
  );
}
