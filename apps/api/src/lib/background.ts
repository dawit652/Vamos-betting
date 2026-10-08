import type { FastifyBaseLogger } from 'fastify';

/**
 * Work started by a request that must not delay its response (e.g. an SMS
 * whose latency would reveal whether a number has an account). Failures are
 * logged; nothing is retried. `idle()` waits for everything in flight; the
 * app awaits it on close, and tests use it before reading the results.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: Pick<FastifyBaseLogger, 'error'>) {}

  run(name: string, task: () => Promise<void>): void {
    const promise = (async () => {
      try {
        await task();
      } catch (error) {
        this.log.error({ err: error, task: name }, 'background task failed');
      }
    })();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  /** Resolves once no task is running (tasks started meanwhile are awaited too). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}
