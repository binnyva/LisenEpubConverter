import { AsyncLocalStorage } from 'node:async_hooks';

export const TASK_CANCELLED_MESSAGE = 'Task cancelled by user.';

export class TaskCancelledError extends Error {
  constructor() {
    super(TASK_CANCELLED_MESSAGE);
    this.name = 'TaskCancelledError';
  }
}

const signals = new AsyncLocalStorage<AbortSignal | undefined>();

/** Make a task cancellation signal available to all of its asynchronous stage work. */
export function withTaskCancellation<T>(signal: AbortSignal | undefined, run: () => T): T {
  return signals.run(signal, run);
}

export function taskCancellationSignal(): AbortSignal | undefined {
  return signals.getStore();
}

export function throwIfTaskCancelled(): void {
  if (taskCancellationSignal()?.aborted) throw new TaskCancelledError();
}

/** A cancellation-aware retry delay. */
export function waitForRetry(ms: number): Promise<void> {
  const signal = taskCancellationSignal();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new TaskCancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TaskCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
