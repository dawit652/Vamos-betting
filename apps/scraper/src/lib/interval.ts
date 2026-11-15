import type { Logger } from 'pino';
/** A long-running background job (an interval loop). */
export interface ScraperTask {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface IntervalTaskOptions {
  name: string;
  /** Time between the starts of two runs; a run that takes longer delays the next one. */
  intervalMs: number;
  run: () => Promise<unknown>;
  logger: Logger;
  /** Run once right after start (default true). */
  runOnStart?: boolean;
}

export interface IntervalTask extends ScraperTask {
  /** Runs once now, after any run in progress (for tests and manual triggers). */
  runNow: () => Promise<void>;
}

/**
 * A ScraperTask that runs `run` every `intervalMs`. Runs never overlap, a
 * failed run is logged and the schedule carries on, and stop() waits for the
 * run in progress to finish.
 */
export function intervalTask(options: IntervalTaskOptions): IntervalTask {
  const { name, intervalMs, run, logger } = options;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new RangeError(`${name}: intervalMs must be >= 1, got ${intervalMs}`);
  }
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = true;

  const runOnce = async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logger.error({ err: error, task: name }, 'task run failed');
    }
  };

  const exclusive = async (): Promise<void> => {
    while (running !== null) await running;
    const current = runOnce();
    running = current;
    try {
      await current;
    } finally {
      running = null;
    }
  };

  const loop = (): void => {
    timer = null;
    if (stopped) return;
    const startedAt = Date.now();
    void exclusive().finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, Math.max(0, intervalMs - (Date.now() - startedAt)));
    });
  };

  return {
    name,
    start: async () => {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(loop, options.runOnStart === false ? intervalMs : 0);
    },
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      while (running !== null) await running;
    },
    runNow: exclusive,
  };
}
