import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { shouldKeepKey } from './idempotency';

const problem = (type: string) => ({ type });

describe('shouldKeepKey', () => {
  it('keeps the key when the outcome is unknown', () => {
    expect(shouldKeepKey(new ApiError(0, 'sin red', null))).toBe(true);
    expect(shouldKeepKey(new ApiError(409, 'en proceso', problem('urn:pialy:problem:request-in-progress')))).toBe(true);
  });

  it.each([
    new ApiError(502, 'Intenta de nuevo.', null),
    new ApiError(500, 'error', null),
    new ApiError(429, 'muchas solicitudes', null),
    new ApiError(422, 'invalido', null),
    new ApiError(409, 'ocupado', problem('urn:pialy:problem:slot-taken')),
    new ApiError(409, 'sin tipo', null),
  ])('resets the key on a final error (%s)', (error) => {
    expect(shouldKeepKey(error)).toBe(false);
  });
});
