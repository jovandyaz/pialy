export const BUSINESS = {
  name: 'Estudio Demo',
  service: 'Consulta',
  serviceMinutes: 45,
  deposit: '$0.01',
  depositMxn: '$0.01 MXN',
  depositCents: 1,
} as const;

const CENTS_PER_PESO = 100;

export function depositsTotal(paidCount: number): string {
  return `$${((paidCount * BUSINESS.depositCents) / CENTS_PER_PESO).toFixed(2)}`;
}
