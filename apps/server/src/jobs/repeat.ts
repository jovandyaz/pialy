import { safeError } from './safe-error.js';

export interface Repeating {
  /** Stops scheduling, signals the run in progress and waits for it to end. */
  stop(): Promise<void>;
}

export interface RepeatLogger {
  error(context: object, message: string): void;
}

/**
 * Runs `task` now and again `intervalMs` after each run ends, so runs never overlap. A failed run
 * is logged and the next one still happens.
 */
export function startRepeating(
  name: string,
  task: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  log: RepeatLogger,
): Repeating {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  function run(): void {
    // Through the executor, a task that throws instead of rejecting is still caught.
    running = new Promise<unknown>((resolve) => resolve(task(controller.signal)))
      .then(
        () => undefined,
        (error: unknown) => log.error({ job: name, err: safeError(error) }, `${name} run failed`),
      )
      .finally(() => {
        running = undefined;
        if (!controller.signal.aborted) timer = setTimeout(run, intervalMs);
      });
  }

  run();
  return {
    async stop() {
      controller.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
