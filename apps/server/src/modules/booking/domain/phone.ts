/** The input is not a Mexican 10-digit phone number. The message never repeats the input. */
export class InvalidPhoneError extends Error {
  override readonly name = 'InvalidPhoneError';

  constructor() {
    super('phone must be a Mexican 10-digit number');
  }
}

const SEPARATORS = /[\s\-().]/g;
const COUNTRY_PREFIX = '+52';
const COUNTRY_CODE = '52';
const LEGACY_MOBILE_PREFIXES = ['044', '045'] as const;
const NATIONAL_DIGITS = 10;
/** Mexican area codes never start with 0 or 1. */
const NATIONAL_NUMBER = /^[2-9]\d{9}$/;
const DIGITS = /^\d+$/;

/**
 * Normalizes what a customer types into the 10-digit national number CoDi expects: drops spaces,
 * dashes, dots and parentheses, a `+52` or bare `52` country code and the old `044`/`045` mobile
 * prefixes. Throws {@link InvalidPhoneError} for anything else.
 */
export function normalizeMxPhone(input: string): string {
  const compact = input.replace(SEPARATORS, '');
  const national = compact.startsWith('+') ? withoutCountryPrefix(compact) : withoutDomesticPrefix(compact);
  if (national === null || !NATIONAL_NUMBER.test(national)) throw new InvalidPhoneError();
  return national;
}

export function phoneLast4(phone10: string): string {
  return phone10.slice(-4);
}

function withoutCountryPrefix(compact: string): string | null {
  return compact.startsWith(COUNTRY_PREFIX) ? compact.slice(COUNTRY_PREFIX.length) : null;
}

function withoutDomesticPrefix(compact: string): string | null {
  if (!DIGITS.test(compact)) return null;
  if (compact.length === NATIONAL_DIGITS + COUNTRY_CODE.length && compact.startsWith(COUNTRY_CODE)) {
    return compact.slice(COUNTRY_CODE.length);
  }
  const legacy = LEGACY_MOBILE_PREFIXES.find((prefix) => compact.startsWith(prefix));
  if (legacy !== undefined && compact.length === NATIONAL_DIGITS + legacy.length) {
    return compact.slice(legacy.length);
  }
  return compact;
}
