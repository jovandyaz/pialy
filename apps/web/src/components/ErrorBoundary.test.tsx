import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('shows a reload prompt instead of a blank page when a child throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Algo salió mal');
    expect(screen.getByRole('button', { name: 'Recargar' })).toBeTruthy();
    consoleError.mockRestore();
  });

  it('renders its children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>ok</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('ok')).toBeTruthy();
  });
});
