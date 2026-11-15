import type { ReactNode } from 'react';
import { STATUS, type BookingView } from '../api';
import { QrCode } from '../components/QrCode';
import { Screen } from '../components/Screen';
import { Numeral } from '../components/ui/Numeral';
import { KeyValues, Label, Panel } from '../components/ui/Panel';
import { StatusTag } from '../components/ui/StatusTag';
import { BUSINESS } from '../lib/business';
import { ROUTES } from '../lib/router';
import { formatTime, longDateLabel, minutesBetween } from '../lib/time';
import { bookingLook } from '../ui/status';

const SHORT_TOKEN_LENGTH = 4;

export function PassView({ booking }: { readonly booking: BookingView }) {
  const verifyUrl = new URL(ROUTES.verify(booking.token), window.location.origin).toString();
  const shortPass = `${window.location.host}${ROUTES.verify(booking.token.slice(0, SHORT_TOKEN_LENGTH))}…`;
  const pass = booking.pass;
  const used = booking.status === STATUS.checkedIn;
  const rows: [string, ReactNode][] = [['Anticipo', BUSINESS.depositMxn]];
  if (pass?.bankName) rows.push(['Banco', pass.bankName]);
  if (pass) rows.push(['Celular', `··${pass.phoneLast4}`]);
  if (pass?.trackingKey) rows.push(['Clave de rastreo', <span className="tabular-nums">{pass.trackingKey}</span>]);
  rows.push(['Pase', <span className="tabular-nums">{shortPass}</span>]);

  return (
    <Screen>
      <Panel as="header" tone="paid" className="px-5 py-4.5">
        <Label tone="onPaid">Anticipo confirmado por tu banco</Label>
        <h1 className="mt-1 text-[28px] leading-[1.05] font-extrabold tracking-[-0.02em] font-stretch-108%">{BUSINESS.name}</h1>
      </Panel>
      <Numeral size="pass" className="block px-5 pt-4.5 pb-1.5">
        {formatTime(booking.slot.start)}
      </Numeral>
      <p className="px-5 font-bold">
        {longDateLabel(booking.slot.start)} · {BUSINESS.service} {minutesBetween(booking.slot.start, booking.slot.end)} min
      </p>
      {booking.late || used ? (
        <div className="flex gap-2 px-5 pt-3">
          {booking.late ? <StatusTag look={bookingLook(STATUS.confirmed, true)} /> : null}
          {used ? <StatusTag look={bookingLook(STATUS.checkedIn, false)} /> : null}
        </div>
      ) : null}
      <QrCode value={verifyUrl} label="Código del pase" className="mx-auto mt-3 mb-1 size-50" />
      <KeyValues rows={rows} className="mx-5" />
      <p className="mx-5 mt-3 text-[13px] text-muted">Muestra este pase al llegar. Confirma el pago de la cita, no tu identidad.</p>
    </Screen>
  );
}
