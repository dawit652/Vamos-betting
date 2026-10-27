import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { gracefulShutdown, installLastResortHandlers } from './lifecycle';

const quietLogger = () => ({ info: vi.fn(), error: vi.fn(), fatal: vi.fn() });

describe('last-resort error handler (ASVS 7.4.3)', () => {
  it('logs an uncaught error as fatal, shuts down once and exits 1', async () => {
    const logger = quietLogger();
    const exit = vi.fn();
    const closed = vi.fn(async () => undefined);
    const shutdown = gracefulShutdown({
      logger,
      timeoutMs: 1_000,
      exit,
      steps: [{ name: 'pools', run: closed }],
    });
    const source = new EventEmitter();
    installLastResortHandlers({ logger, shutdown, source });

    const boom = new Error('boom');
    source.emit('unhandledRejection', boom);
    source.emit('uncaughtException', new Error('again'));
    await shutdown('test');

    expect(logger.fatal).toHaveBeenCalledWith(
      { err: boom, kind: 'unhandledRejection' },
      'unhandled error; shutting down',
    );
    expect(logger.fatal).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits 0 after a clean signal shutdown', async () => {
    const exit = vi.fn();
    const shutdown = gracefulShutdown({ logger: quietLogger(), timeoutMs: 1_000, exit, steps: [] });
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
