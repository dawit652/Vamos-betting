import { loadConfig } from '@vamos/config';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { startWorker, type WorkerTask } from '../src/worker';

const logger = pino({ level: 'silent' });

function task(name: string, log: string[], failOnStart = false): WorkerTask {
  return {
    name,
    start: () => {
      if (failOnStart) return Promise.reject(new Error(`${name} failed`));
      log.push(`start:${name}`);
      return Promise.resolve();
    },
    stop: () => {
      log.push(`stop:${name}`);
      return Promise.resolve();
    },
  };
}

describe('startWorker', () => {
  it('starts tasks in order and stops them in reverse', async () => {
    const log: string[] = [];
    const handle = await startWorker(loadConfig({ OPERATING_MODE: 'demo' }), logger, [
      task('a', log),
      task('b', log),
    ]);
    expect(handle.tasks).toEqual(['a', 'b']);
    await handle.stop();
    expect(log).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
  });

  it('stops already-started tasks when a later task fails to start', async () => {
    const log: string[] = [];
    await expect(
      startWorker(loadConfig({ OPERATING_MODE: 'demo' }), logger, [
        task('a', log),
        task('b', log, true),
      ]),
    ).rejects.toThrow('b failed');
    expect(log).toEqual(['start:a', 'stop:a']);
  });
});
