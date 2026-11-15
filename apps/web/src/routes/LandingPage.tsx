/**
 * THESIS: the page IS a live appointment slot at any business; each loop the hero flips a slot free → "Alguien paga"
 * (06:00) → "Anticipo pagado" at a different example business with its own deposit. Refuses: centered hero,
 * feature-card grid, testimonials, payment-rail headline.
 * OWN-WORLD: white paper on a pale cobalt dot matrix (the unlit panel the Doto numerals light up), Doto for times and
 * amounts, hatched taken slots, green paid stamp, amber late tag, dotted menu leaders; 1px rules; 2px corners.
 * STORY: an owner sees bookings with deposits → sets the amount → the hold lives with the bank request → the agenda
 * hears it, the door scans the pass → edge cases handled → try the demo.
 * FIRST VIEWPORT (390): mark, h1, short offer, live slot card, "Probar la demo". Desktop: copy left, phones right.
 * FORM: "live slot", extended in its established world. FINISH: unreviewed and undocumented is unfinished; this
 * build ends with the finish review, the verdict, and DESIGN.md.
 */
import { useEffect, type ReactNode } from 'react';
import { STATUS } from '../api';
import { QrCode } from '../components/QrCode';
import { buttonClass } from '../components/ui/Button';
import { Numeral } from '../components/ui/Numeral';
import { KeyValues, Label, Panel } from '../components/ui/Panel';
import { StatusPill, StatusTag } from '../components/ui/StatusTag';
import { BUSINESS } from '../lib/business';
import { cn } from '../lib/cn';
import { ROUTES, spaLink } from '../lib/router';
import { formatCountdown } from '../lib/useHoldCountdown';
import { HOLD_SECONDS, LOOP_PHASE, PAID_LOOP, useSlotLoop, type SlotLoop } from '../lib/useSlotLoop';
import { bookingLook, FREE_LOOK, type StatusLook } from '../ui/status';

const LANDING_TITLE = 'Pialy · Citas con anticipo para tu negocio';
const MS_PER_SECOND = 1000;
const PERCENT = 100;
const EXAMPLE_QR_VALUE = 'Pialy · pase de ejemplo';

const EXAMPLE = {
  day: 'Dom 15 nov',
  boardDay: 'dom 15',
  time: '11:15',
  bank: 'BBVA',
  phoneLast4: '5678',
} as const;

/** Every example screen shares one frame height, so screens shown side by side line up top and bottom. */
const SCREEN_HEIGHT = 'h-[392px]';

/** Example businesses: each sets its own deposit. Synthetic, always shown under an "Ejemplo" label. */
interface BusinessExample {
  readonly giro: string;
  readonly business: string;
  readonly service: string;
  readonly duration: string;
  readonly deposit: string;
  readonly customer: string;
}

const EXAMPLES = [
  { giro: 'Barbería', business: 'Tu barbería', service: 'Corte y barba', duration: '45 min', deposit: '$150', customer: 'Jorge P.' },
  { giro: 'Consultorio', business: 'Tu consultorio', service: 'Consulta', duration: '50 min', deposit: '$300', customer: 'Sofía R.' },
  { giro: 'Estética', business: 'Tu estética', service: 'Uñas acrílicas', duration: '90 min', deposit: '$200', customer: 'Daniela M.' },
  { giro: 'Taller', business: 'Tu taller', service: 'Afinación', duration: '3 h', deposit: '$400', customer: 'Ramón T.' },
  { giro: 'Estudio de tatuaje', business: 'Tu estudio', service: 'Sesión de tatuaje', duration: '2 h', deposit: '$500', customer: 'Valeria L.' },
] as const satisfies readonly BusinessExample[];

const [FIRST_EXAMPLE, SCREENS_EXAMPLE] = EXAMPLES;

/** One example business per loop, so the same mechanism plays out across giros. */
function exampleFor(loop: SlotLoop): BusinessExample {
  return EXAMPLES[loop.cycle % EXAMPLES.length] ?? FIRST_EXAMPLE;
}

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
        <Deposits />
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

const shell = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-10';
const textLink = 'inline-flex min-h-11 items-center font-bold underline decoration-2 underline-offset-4';

function DemoCta({ className }: { readonly className?: string }) {
  return (
    <a href={ROUTES.book} onClick={spaLink(ROUTES.book)} className={cn(buttonClass({ variant: 'brand' }), className)}>
      Probar la demo
    </a>
  );
}

function AgendaLink({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  return (
    <a href={ROUTES.board} onClick={spaLink(ROUTES.board)} className={cn(textLink, className)}>
      {children}
    </a>
  );
}

function SiteHeader() {
  return (
    <header className="border-b border-ink bg-paper">
      <div className={cn(shell, 'flex min-h-15 items-center justify-between gap-4')}>
        <a href={ROUTES.landing} aria-label="Pialy, inicio" className="inline-flex min-h-11 items-center">
          <Numeral size="sheet" tone="brand" className="text-[32px] leading-none">
            pialy
          </Numeral>
        </a>
        <AgendaLink className="text-[15px]">Entrar a tu agenda</AgendaLink>
      </div>
    </header>
  );
}

function Hero({ loop }: { readonly loop: SlotLoop }) {
  const example = exampleFor(loop);
  return (
    <section aria-labelledby="hero-title" className="dot-bg border-b border-ink">
      <div className={cn(shell, 'grid gap-8 pt-6 pb-10 md:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] md:items-center md:gap-10 md:py-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-14 lg:py-20')}>
        <div className="max-w-xl">
          <h1
            id="hero-title"
            className="text-[38px] leading-[1.0] font-extrabold tracking-[-0.03em] text-balance font-stretch-110% sm:text-5xl lg:text-[60px]"
          >
            Cobra un anticipo por cada cita.
          </h1>
          <p className="mt-3 max-w-[44ch] text-[17px] lg:mt-5 lg:text-xl">
            La agenda en línea para negocios que trabajan con citas. Tu cliente aparta su horario y paga desde la app de su banco,
            con CoDi®, sin tarjeta.
          </p>
          <LiveSlotCard loop={loop} example={example} className="mt-5 md:hidden" />
          <div className="mt-5 flex flex-col gap-2 sm:max-w-sm lg:mt-8">
            <DemoCta />
            <p className="text-center text-[13px] text-muted sm:text-left">La demo cobra $0.01 real desde tu banco y no se devuelve. Antes de probar, registra tu celular en CoDi en la app de tu banco.</p>
          </div>
        </div>
        <PhonePair loop={loop} example={example} />
        {/* Breakpoint twin of the in-column card (md:hidden): only one is ever displayed. */}
        <LiveSlotCard loop={loop} example={example} className="hidden md:block lg:hidden" />
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

interface LoopProps {
  readonly loop: SlotLoop;
  readonly example: BusinessExample;
}

function LiveSlotCard({ loop, example, className }: LoopProps & { readonly className?: string }) {
  const look = SLOT_LOOK[loop.phase];
  const paid = loop.phase === LOOP_PHASE.paid;
  return (
    <figure className={cn('border border-ink bg-paper', className)}>
      <figcaption className="flex items-center justify-between gap-3 border-b border-ink px-3 py-2">
        <Label>Ejemplo · {example.business}</Label>
        <span className="sr-only">
          El horario de las {EXAMPLE.time} pasa de libre a «alguien paga», con 6 minutos para pagar un anticipo de {example.deposit}, y a
          «anticipo pagado» cuando el banco confirma.
        </span>
        <span aria-hidden="true" className="text-[13px] font-bold whitespace-nowrap text-muted">
          {EXAMPLE.day}
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
            <div>
              <Numeral size="sheet" className="block text-[76px] leading-[0.85] tracking-tight">{EXAMPLE.time}</Numeral>
              <span key={example.business} className={cn('mt-1.5 block animate-rise text-[13px] font-bold', paid ? 'text-paid-wash' : 'text-muted')}>
                {example.service} · {example.duration}
              </span>
            </div>
            {loop.phase === LOOP_PHASE.held ? (
              <Numeral size="sheet" tone="brand" className="text-[34px] leading-none">
                {formatCountdown(loop.remainingSeconds * MS_PER_SECOND)}
              </Numeral>
            ) : null}
          </div>
          {paid ? (
            <div key={loop.cycle} className="flex animate-rise items-end justify-between gap-3">
              <span className="-rotate-2 rounded-sm border-2 border-paper px-2 py-1 text-[15px] font-extrabold tracking-[0.06em] whitespace-nowrap uppercase">
                {look.label}
              </span>
              <span className="text-right text-[13px] leading-tight font-bold text-paid-wash">
                <Numeral size="sheet" className="block text-[26px] text-paper">{example.deposit}</Numeral>
                lo confirmó el banco
              </span>
            </div>
          ) : (
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn('text-[15px] font-bold', loop.phase === LOOP_PHASE.held ? 'text-brand' : 'text-muted')}>{look.label}</span>
                <span className="text-[15px] font-bold">Anticipo {example.deposit}</span>
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

function PhonePair({ loop, example }: LoopProps) {
  return (
    <figure className="hidden lg:block">
      <figcaption className="mb-3">
        <Label>Ejemplo · el mismo pago en los dos celulares</Label>
      </figcaption>
      <div aria-hidden="true" className="grid grid-cols-[320px_320px] items-start gap-6">
        <CustomerPhone loop={loop} example={example} />
        <OwnerAgenda loop={loop} example={example} />
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

function PassHeader({ business }: { readonly business: string }) {
  return (
    <Panel as="div" tone="paid" className="px-4 py-3.5">
      <Label tone="onPaid" className="text-[11px]">
        Anticipo confirmado por tu banco
      </Label>
      <b className="mt-0.5 block text-xl font-extrabold">{business}</b>
    </Panel>
  );
}

function PassTime({ example }: { readonly example: BusinessExample }) {
  return (
    <>
      <Numeral size="sheet" className="block px-4 pt-3 text-[80px] leading-[0.85] tracking-tight">{EXAMPLE.time}</Numeral>
      <p className="px-4 pt-1 text-sm font-bold">
        {EXAMPLE.day} · {example.service} {example.duration}
      </p>
    </>
  );
}

const CUSTOMER_CAPTION = 'Tu cliente · su celular';

function CustomerPhone({ loop, example }: LoopProps) {
  if (loop.phase === LOOP_PHASE.paid) {
    return (
      <Device caption={CUSTOMER_CAPTION}>
        <div key={loop.cycle} className={cn(SCREEN_HEIGHT, 'animate-rise')}>
          <PassHeader business={example.business} />
          <PassTime example={example} />
          <QrCode value={EXAMPLE_QR_VALUE} label="QR ilustrativo" className="mx-auto mt-3 size-32" />
          <p className="text-center text-[11px] text-gone">QR ilustrativo</p>
        </div>
      </Device>
    );
  }
  return (
    <Device caption={CUSTOMER_CAPTION}>
      <div className={SCREEN_HEIGHT}>
        <div className="flex items-center justify-between border-b border-ink px-4 pt-3.5 pb-2.5">
          <span className="text-[15px] font-extrabold font-stretch-105%">{example.business}</span>
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
              <b>2.</b> Busca la solicitud de cobro
            </li>
            <li className="border-b border-brand/35 py-2">
              <b>3.</b> Autoriza {example.deposit}
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

const AGENDA_BEFORE: readonly ExampleRow[] = [
  { time: '09:00', name: 'Ana R.', detail: 'Pase usado 09:02', look: bookingLook(STATUS.checkedIn, false) },
  { time: '09:45', name: 'María G.', detail: 'Banorte · ··0912', look: PAID_LOOK },
];

function liveRow({ loop, example }: LoopProps): ExampleRow {
  if (loop.phase === LOOP_PHASE.free) return { time: EXAMPLE.time, ...EMPTY_ROW };
  if (loop.phase === LOOP_PHASE.held) {
    return { time: EXAMPLE.time, name: example.customer, detail: 'Esperando su banco', look: bookingLook(STATUS.holding, false) };
  }
  return { time: EXAMPLE.time, name: example.customer, detail: `${EXAMPLE.bank} · ··${EXAMPLE.phoneLast4}`, look: PAID_LOOK };
}

function OwnerAgenda({ loop, example }: LoopProps) {
  const paid = loop.phase === LOOP_PHASE.paid;
  const paidCount = AGENDA_BEFORE.length + (paid ? 1 : 0);
  return (
    <Device caption="Tu negocio · la agenda">
      <div className={cn(SCREEN_HEIGHT, 'relative flex flex-col')}>
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
          {AGENDA_BEFORE.map((row) => (
            <AgendaRow key={row.time} row={row} />
          ))}
          <AgendaRow row={liveRow({ loop, example })} flashKey={paid ? loop.cycle : null} />
        </ol>
        {paid ? (
          <div key={loop.cycle} className="absolute inset-x-3 bottom-3 flex animate-rise items-center gap-3 rounded-sm bg-paid px-3.5 py-3 font-bold text-paper">
            <Numeral size="toast">{EXAMPLE.time}</Numeral>
            <span className="text-sm leading-tight">
              Anticipo recibido
              <span className="block font-semibold text-paid-wash">de {example.customer}</span>
            </span>
          </div>
        ) : null}
      </div>
    </Device>
  );
}

function AgendaRow({ row, flashKey = null }: { readonly row: ExampleRow; readonly flashKey?: number | null }) {
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

function SectionHeading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2 id={id} className="max-w-2xl text-[30px] leading-[1.04] font-extrabold tracking-[-0.025em] text-balance font-stretch-108% lg:text-[44px]">
      {children}
    </h2>
  );
}

function Deposits() {
  return (
    <section aria-labelledby="deposits-title" className="border-b border-ink">
      <div className={cn(shell, 'grid gap-8 py-14 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-10 lg:gap-16 lg:py-24')}>
        <div>
          <SectionHeading id="deposits-title">Tú decides cuánto pides de anticipo.</SectionHeading>
          <p className="mt-4 max-w-[48ch] text-muted lg:text-lg">
            Barberías, estéticas, consultorios, estudios, talleres: cualquier negocio que trabaje con citas. Un corte, una consulta y una
            afinación no valen lo mismo, así que cada negocio fija su monto.
          </p>
        </div>
        <figure>
          <figcaption>
            <Label>Ejemplo · cada negocio fija su anticipo</Label>
          </figcaption>
          <ul className="mt-2.5 border-t-2 border-ink">
            {EXAMPLES.map((example) => (
              <li key={example.giro} className="flex items-end gap-3 border-b border-brand/35 py-3">
                <span className="min-w-0">
                  <b className="block text-[17px] leading-tight">{example.giro}</b>
                  <span className="text-[14px] text-muted">
                    {example.service} · {example.duration}
                  </span>
                </span>
                <span aria-hidden="true" className="mb-2 min-w-6 flex-1 border-b-2 border-dotted border-gone/70" />
                <Numeral size="sheet" tone="brand" className="text-[36px] leading-none lg:text-[44px]">
                  {example.deposit}
                </Numeral>
              </li>
            ))}
          </ul>
        </figure>
      </div>
    </section>
  );
}

const STEPS = [
  {
    at: '00:00',
    title: 'Aparta y le llega el cobro',
    body: 'Tu cliente elige horario y escribe su celular. La solicitud de cobro le llega a la app de su banco y el horario queda apartado.',
  },
  {
    at: '00:40',
    title: 'Si no le llegó, un QR',
    body: 'Si la notificación no aparece, la pantalla le ofrece un QR para pagar con la misma app. Nunca se queda esperando sin salida.',
  },
  {
    at: '06:00',
    title: 'Si no paga, se libera',
    body: 'El apartado dura lo que vive la solicitud del banco. Al vencer, el horario vuelve a estar libre para alguien más.',
  },
] as const;

function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="dot-bg border-b border-ink">
      <div className={cn(shell, 'py-14 lg:py-24')}>
        <SectionHeading id="how-title">Una cita que no llega es una hora que ya no vendes.</SectionHeading>
        <p className="mt-4 max-w-[60ch] lg:text-lg">
          Con un anticipo, apartar ya es un compromiso. El horario se guarda mientras la solicitud de cobro sigue viva en el banco de tu
          cliente y se confirma solo cuando el banco confirma el pago.
        </p>
        <ol className="mt-9 border-l-2 border-ink lg:grid lg:grid-cols-3 lg:border-t-2 lg:border-l-0">
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
      <div className={cn(shell, 'grid gap-8 py-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-14 lg:py-24')}>
        <div className="max-w-xl">
          <SectionHeading id="screens-title">El anticipo llega y tu agenda te avisa.</SectionHeading>
          <ul className="mt-6 border-t border-ink">
            <Point title="Te enteras sin mirar">El renglón se pinta de verde y la agenda dice «Anticipo recibido» en voz alta.</Point>
            <Point title="Tu cliente recibe su pase">Con la hora y los últimos dígitos de su celular. Sin cuenta y sin instalar nada.</Point>
            <Point title="En la puerta, un escaneo">El pase se marca una sola vez al llegar. Confirma el pago de la cita, no la identidad.</Point>
          </ul>
        </div>
        <div role="group" aria-label="Ejemplo de las dos pantallas" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-[repeat(2,320px)]">
          <div>
            <Label className="mb-2 block">Ejemplo</Label>
            <OwnerAgenda loop={PAID_LOOP} example={SCREENS_EXAMPLE} />
          </div>
          <div>
            <Label className="mb-2 block">Ejemplo</Label>
            <ExamplePass example={SCREENS_EXAMPLE} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** The customer's pass, sized to the agenda's frame: the QR takes whatever height is left between the time and the details. */
function ExamplePass({ example }: { readonly example: BusinessExample }) {
  return (
    <Device caption="Tu cliente · su pase">
      <div className={cn(SCREEN_HEIGHT, 'flex flex-col')}>
        <PassHeader business={example.business} />
        <PassTime example={example} />
        <QrCode value={EXAMPLE_QR_VALUE} label="QR ilustrativo del pase" className="m-auto size-22" />
        <KeyValues
          className="mx-4 mb-3"
          rows={[
            ['Anticipo', `${example.deposit} MXN`],
            ['Celular', `··${EXAMPLE.phoneLast4}`],
          ]}
        />
      </div>
    </Device>
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

/** Owner-facing promises, benefit first; the mechanics behind each one live in the README, not here. */
const CASES = [
  { title: 'Si te pagan tarde, no pierdes la cita', body: 'Si el horario sigue libre, la cita se confirma igual.' },
  {
    title: 'Ningún pago se pierde ni se cuenta doble',
    body: 'Si alguien paga dos veces, o paga un horario que ya se ocupó, tu agenda te dice qué devolver.',
  },
  { title: 'Un horario pagado no se libera por error', body: 'Antes de ofrecerlo a alguien más, Pialy revisa que nadie lo haya pagado.' },
  { title: 'Cada pase sirve para una sola visita', body: 'Si alguien vuelve a mostrar el mismo pase, al escanearlo ves que ya se usó y a qué hora.' },
] as const;

/** Promise beside its explanation; on desktop the promise column hugs the longest promise so each row reads as one line. */
const CASE_ROW_COLUMNS = 'sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-cols-[400px_minmax(0,1fr)]';

function HardCases() {
  return (
    <section aria-labelledby="cases-title" className="border-b border-ink">
      <div className={cn(shell, 'py-14 lg:py-24')}>
        <SectionHeading id="cases-title">Lo difícil ya está resuelto.</SectionHeading>
        <ul className="mt-7 border-t border-ink">
          {CASES.map((item) => (
            <li
              key={item.title}
              className={cn('grid gap-x-6 gap-y-1 border-b border-brand/35 py-4 sm:items-baseline lg:py-5', CASE_ROW_COLUMNS)}
            >
              <b className="text-[17px] lg:text-lg">{item.title}</b>
              <span className="text-[15px] text-muted">{item.body}</span>
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
      <div className={cn(shell, 'grid gap-4 py-9 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-10')}>
        <span className="w-fit -rotate-2 rounded-sm border-2 border-paid px-2.5 py-1 text-[15px] font-extrabold tracking-[0.06em] text-paid uppercase">
          Probado
        </span>
        <div>
          <p className="text-lg font-bold lg:text-xl">Con pagos reales, confirmados por el banco.</p>
          <p className="mt-1.5">Una cita se marca como pagada solo cuando el banco lo confirma, nunca por una captura de pantalla.</p>
        </div>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section aria-labelledby="close-title" className="dot-bg">
      <div className={cn(shell, 'py-16 lg:py-28')}>
        <div className="grid gap-6 border-2 border-ink bg-paper p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-end lg:gap-12 lg:p-12">
          <div>
            <Numeral size="sheet" tone="brand" aria-hidden="true" className="block text-[96px] leading-[0.82] tracking-tight lg:text-[152px]">
              {formatCountdown(HOLD_SECONDS * MS_PER_SECOND)}
            </Numeral>
            <h2
              id="close-title"
              className="mt-5 text-[34px] leading-[1.0] font-extrabold tracking-[-0.03em] text-balance font-stretch-110% lg:text-[60px]"
            >
              Pruébalo con tu propio banco.
            </h2>
            <p className="mt-3 max-w-[46ch] text-muted lg:text-lg">
              Aparta una cita en el {BUSINESS.name}: tienes seis minutos para pagar desde la app de tu banco y ver cómo llega a la
              agenda.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <DemoCta />
          </div>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t-2 border-ink bg-paper">
      <div className={cn(shell, 'flex flex-col gap-4 py-8 sm:flex-row sm:items-baseline sm:gap-8 lg:py-10')}>
        <Numeral size="sheet" tone="brand" className="text-[48px] leading-[0.8]">
          pialy
        </Numeral>
        <p className="text-[15px] font-bold sm:flex-1">Citas con anticipo para tu negocio.</p>
        <p className="text-sm text-muted">© 2026 Pialy</p>
      </div>
    </footer>
  );
}
