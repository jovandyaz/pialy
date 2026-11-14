export const AttemptStatus = {
  Awaiting: 'awaiting',
  Succeeded: 'succeeded',
  Expired: 'expired',
  Failed: 'failed',
} as const;
export type AttemptStatus = (typeof AttemptStatus)[keyof typeof AttemptStatus];

export const AttemptMode = {
  Push: 'push',
  Qr: 'qr',
} as const;
export type AttemptMode = (typeof AttemptMode)[keyof typeof AttemptMode];

/** One try at collecting an intent on a rail (CoDi push or QR). */
export interface PaymentAttempt {
  readonly id: string;
  readonly intentId: string;
  readonly mode: AttemptMode;
  readonly status: AttemptStatus;
  readonly expiresAt: Date;
  readonly provider: {
    readonly transactionId?: string;
    readonly qrId?: string;
    readonly codiId?: string;
  };
}
