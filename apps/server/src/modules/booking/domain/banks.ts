/** Banxico participant codes pey reports as the payer's `bankCode`. */
const BANK_NAMES: Readonly<Record<string, string>> = {
  '40012': 'BBVA',
  '40072': 'Banorte',
  '40014': 'Santander',
  '40002': 'Banamex',
  '40021': 'HSBC',
  '40036': 'Inbursa',
  '40127': 'Azteca',
};

/** The bank's name; `null` for a missing or unknown code. */
export function bankNameOf(code: string | number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return Object.hasOwn(BANK_NAMES, String(code)) ? (BANK_NAMES[String(code)] ?? null) : null;
}
