import { describe, expect, it } from 'vitest';
import { formatPhoneInput, phoneDigits } from './phone';

describe('formatPhoneInput', () => {
  it('groups ten digits as 2-4-4', () => {
    expect(formatPhoneInput('5512345678')).toBe('55 1234 5678');
  });

  it('formats partial input while typing', () => {
    expect(formatPhoneInput('5')).toBe('5');
    expect(formatPhoneInput('55')).toBe('55');
    expect(formatPhoneInput('551')).toBe('55 1');
    expect(formatPhoneInput('551234')).toBe('55 1234');
    expect(formatPhoneInput('5512345')).toBe('55 1234 5');
  });

  it('drops anything that is not a digit', () => {
    expect(formatPhoneInput('55-12 34.56(78)')).toBe('55 1234 5678');
    expect(formatPhoneInput('abc')).toBe('');
  });

  it('caps at ten digits', () => {
    expect(formatPhoneInput('551234567890')).toBe('55 1234 5678');
  });

  it('strips a pasted +52 country code', () => {
    expect(formatPhoneInput('+52 55 1234 5678')).toBe('55 1234 5678');
    expect(formatPhoneInput('+525512345678')).toBe('55 1234 5678');
  });

  it('is stable when reformatting its own output', () => {
    expect(formatPhoneInput(formatPhoneInput('5512345678'))).toBe('55 1234 5678');
  });
});

describe('phoneDigits', () => {
  it('returns the ten digits the API expects', () => {
    expect(phoneDigits('55 1234 5678')).toBe('5512345678');
    expect(phoneDigits('+52 55 1234 5678')).toBe('5512345678');
  });
});
