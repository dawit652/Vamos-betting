import type { Database, ElsReporter } from '@vamos/db';
import type { PaymentProviderRegistry } from '@vamos/payments';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { QueueConfig } from '../lib/queues';
import type { SmsSender } from '../lib/sms';

/** What the worker tasks need from the outside world (tests pass their own). */
export interface TaskContext {
  db: Database;
  redis: Redis;
  logger: Logger;
  /** Current time. Tasks read the time only from here. */
  clock: () => Date;
  /** Redis channel for live deltas (LIVE_CHANNEL; tests use a unique one). */
  channel: string;
  /**
   * Prefix of the per-player push channels (default `vamos:user:`, see
   * userChannel in @vamos/contracts; tests use a unique one). The API's
   * GET /me/stream must relay the same prefix.
   */
  userChannelPrefix?: string;
  /** BullMQ queues (settlement, live bet acceptance); tests use a unique prefix. */
  queues: QueueConfig;
  /**
   * The enabled payment providers (PAYMENT_PROVIDERS; only the mock provider
   * in demo mode), used by the payout worker and the deposit reconciliation.
   */
  payments: PaymentProviderRegistry;
  /** The SMS gateway for player notifications (SMS_PROVIDER). */
  sms: SmsSender;
  /**
   * Where the ELS stream and daily summary files go (createElsReporter of
   * config.els). Absent: createTasks builds it from the configuration.
   */
  els?: ElsReporter;
}
