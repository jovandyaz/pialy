import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorNote, Screen, TopBar } from './Screen';
import { Button } from './ui/Button';
import { BUSINESS } from '../lib/business';

interface State {
  readonly failed: boolean;
}

/** Replaces a render crash (or a page chunk that failed to load) with a reload prompt instead of a blank app. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Screen>
        <TopBar title={BUSINESS.name} />
        <div className="p-5">
          <ErrorNote>Algo salió mal al mostrar esta página.</ErrorNote>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Recargar
          </Button>
        </div>
      </Screen>
    );
  }
}
