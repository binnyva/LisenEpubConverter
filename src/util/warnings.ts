import { AsyncLocalStorage } from 'node:async_hooks';

const reporters = new AsyncLocalStorage<(message: string) => void>();

/** Keep provider warnings attached to the run that initiated the async work. */
export function withWarningReporter<T>(report: (message: string) => void, run: () => T): T {
  return reporters.run(report, run);
}

export function reportWarning(message: string): void {
  const report = reporters.getStore();
  if (report) report(message);
  else console.warn(`  ${message}`);
}
