import type { AppConfig } from '@vamos/config';
import type { Logger } from 'pino';

/** A long-running background job runner (queue consumer, scheduler, simulator…). */
export interface WorkerTask {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface WorkerHandle {
  tasks: string[];
  stop: () => Promise<void>;
}

/**
 * Starts every registered task. Tasks are added per phase (feed ingest and the
 * live simulator in Phase 3, settlement in Phase 4, payouts in Phase 6, …).
 */
export async function startWorker(
  config: AppConfig,
  logger: Logger,
  tasks: WorkerTask[] = [],
): Promise<WorkerHandle> {
  logger.info({ mode: config.mode, tasks: tasks.map((t) => t.name) }, 'starting worker');
  const started: WorkerTask[] = [];
  try {
    for (const task of tasks) {
      await task.start();
      started.push(task);
    }
  } catch (error) {
    await Promise.allSettled(started.reverse().map((task) => task.stop()));
    throw error;
  }
  return {
    tasks: started.map((t) => t.name),
    stop: async () => {
      for (const task of [...started].reverse()) {
        try {
          await task.stop();
        } catch (error) {
          logger.error({ err: error, task: task.name }, 'task failed to stop cleanly');
        }
      }
    },
  };
}
