import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimOperatingMode, getDatabaseInstallationId, getDatabaseOperatingMode } from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queuePrefixBindingKey } from '../src/lib/queues';
import { deleteQueueKeys, REDIS_URL, SETUP_TIMEOUT, type TestDatabase } from './helpers';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The worker's BullMQ queues of this file (never the dev stack's). */
const QUEUE_PREFIX = `vamos-test-${randomBytes(6).toString('hex')}-main`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Starts `src/main.ts` in a child process with the given environment. When
 * `stopWhen` matches the output, SIGTERM is sent (clean shutdown).
 */
function runWorker(
  env: Record<string, string>,
  stopWhen?: RegExp,
  beforeStop?: () => Promise<void>,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        REDIS_URL,
        QUEUE_PREFIX,
        // No health server unless a test asks for one (port 4100 may be the dev stack's).
        WORKER_HEALTH_PORT: '0',
        // The tests wait for info lines ('starting worker'); CI runs with LOG_LEVEL=warn.
        LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    const check = () => {
      if (!signalled && stopWhen?.test(stdout)) {
        signalled = true;
        void (beforeStop ?? (() => Promise.resolve()))()
          .catch((error: unknown) => {
            stderr += `beforeStop failed: ${String(error)}`;
          })
          .finally(() => child.kill('SIGTERM'));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      check();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('worker main', () => {
  let demo: TestDatabase;
  let licensed: TestDatabase;

  beforeAll(async () => {
    [demo, licensed] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    await claimOperatingMode(licensed.db, 'licensed');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const handle of [demo, licensed]) {
      handle?.pool.on('error', () => undefined);
      await handle?.drop();
    }
    await deleteQueueKeys(QUEUE_PREFIX);
  }, SETUP_TIMEOUT);

  it(
    'refuses to start on a database that belongs to the other operating mode',
    async () => {
      const run = await runWorker({ DATABASE_URL: licensed.url, OPERATING_MODE: 'demo' });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('[vamos-worker] refusing to start');
      expect(run.stderr).toContain('licensed');
    },
    SETUP_TIMEOUT,
  );

  it(
    'claims the operating mode, starts and shuts down cleanly on SIGTERM',
    async () => {
      const run = await runWorker(
        { DATABASE_URL: demo.url, OPERATING_MODE: 'demo', FEED_PROVIDER: 'manual' },
        /starting worker/,
      );
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('running in DEMO mode');
      expect(run.stdout).toContain('shutting down');
      expect(await getDatabaseOperatingMode(demo.db)).toBe('demo');
      // The queue prefix is now bound to this database.
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
      try {
        expect(await redis.get(queuePrefixBindingKey(QUEUE_PREFIX))).toBe(
          await getDatabaseInstallationId(demo.db),
        );
      } finally {
        await redis.quit();
      }
    },
    SETUP_TIMEOUT,
  );

  it(
    "refuses to start on a queue prefix bound to another database's queues",
    async () => {
      const prefix = `${QUEUE_PREFIX}-taken`;
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
      try {
        await redis.set(queuePrefixBindingKey(prefix), '00000000-0000-4000-8000-00000000abcd');
        const run = await runWorker({
          DATABASE_URL: demo.url,
          OPERATING_MODE: 'demo',
          FEED_PROVIDER: 'manual',
          QUEUE_PREFIX: prefix,
        });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('[vamos-worker] refusing to start');
        expect(run.stderr).toContain(`queue prefix "${prefix}"`);
        expect(run.stdout).not.toContain('starting worker');
      } finally {
        await redis.del(queuePrefixBindingKey(prefix));
        await redis.quit();
      }
    },
    SETUP_TIMEOUT,
  );

  it(
    'serves /health and /ready, drains on SIGTERM and exits 0',
    async () => {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const seen: Array<{ path: string; status: number; body: unknown }> = [];
      const probe = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        seen.push({ path, status: response.status, body: await response.json() });
        return response.status;
      };
      const run = await runWorker(
        {
          DATABASE_URL: demo.url,
          OPERATING_MODE: 'demo',
          FEED_PROVIDER: 'manual',
          WORKER_HEALTH_PORT: String(port),
          WORKER_HEALTH_HOST: '127.0.0.1',
        },
        /starting worker/,
        async () => {
          expect(await probe('/health')).toBe(200);
          // Ready once every queue consumer has connected.
          for (let i = 0; i < 50 && (await probe('/ready')) !== 200; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        },
      );
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      expect(seen[0]).toEqual({
        path: '/health',
        status: 200,
        body: { status: 'ok', service: 'vamos-worker' },
      });
      expect(seen.at(-1)).toEqual({
        path: '/ready',
        status: 200,
        body: {
          status: 'ok',
          checks: { database: { ok: true }, redis: { ok: true }, queues: { ok: true } },
        },
      });
      const lines = run.stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as { msg: string; service: string });
      expect(lines.every((line) => line.service === 'vamos-worker')).toBe(true);
      const messages = lines.map((line) => line.msg);
      expect(messages).toContain('health server listening (/health, /ready)');
      expect(messages.indexOf('shutting down')).toBeLessThan(messages.indexOf('shut down'));
      // The health server is gone with the process.
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    },
    SETUP_TIMEOUT,
  );
});
