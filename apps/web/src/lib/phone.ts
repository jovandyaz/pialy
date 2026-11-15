const MX_DIGITS = 10;
const COUNTRY_CODE = '52';

/** The national 10 digits in whatever the customer typed or pasted (drops a leading +52). */
export function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const national = digits.length > MX_DIGITS && digits.startsWith(COUNTRY_CODE) ? digits.slice(COUNTRY_CODE.length) : digits;
  return national.slice(0, MX_DIGITS);
}

/** Display mask for the phone field: `55 1234 5678`, applied while typing. */
export function formatPhoneInput(raw: string): string {
  const digits = phoneDigits(raw);
  return [digits.slice(0, 2), digits.slice(2, 6), digits.slice(6)].filter((part) => part !== '').join(' ');
}

export function isCompletePhone(raw: string): boolean {
  return phoneDigits(raw).length === MX_DIGITS;
}
