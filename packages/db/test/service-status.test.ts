import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listServiceStatus,
  recordServiceFailure,
  recordServiceOk,
  setServiceAlerted,
  sourceRunReports,
} from '../src/index';
import { dropTestDatabase } from './helpers';
import { addRun, addSource, createScrapeDatabase, type ScrapeTestContext } from './scrape-fixtures';

/**
 * The services' health (docs/plans/counter-codes-and-deposit-recovery.md, G7): each call reports
 * its outcome; a failure keeps the first time it failed until a success; feed sources are judged
 * by their last runs.
 */

let s: ScrapeTestContext;
beforeAll(async () => {
  s = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(s.handle);
});

const T0 = new Date('2026-11-21T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const row = async (service: string) =>
  (await listServiceStatus(s.handle.db)).find((r) => r.service === service);

describe('service status', () => {
  it('keeps the first failure until a success clears it', async () => {
    const db = s.handle.db;
    await recordServiceFailure(db, 'payments:chapa', at(0), 'HTTP 503\n  Service Unavailable');
    await recordServiceFailure(db, 'payments:chapa', at(2), 'timeout');
    expect(await row('payments:chapa')).toMatchObject({
      failingSince: at(0),
      lastFailureAt: at(2),
      lastError: 'timeout',
      lastOkAt: null,
    });
    await recordServiceOk(db, 'payments:chapa', at(3));
    expect(await row('payments:chapa')).toMatchObject({
      failingSince: null,
      lastError: null,
      lastOkAt: at(3),
    });
    // While it works, a success is written at most every 30 seconds.
    await recordServiceOk(db, 'payments:chapa', new Date(at(3).getTime() + 10_000));
    expect((await row('payments:chapa'))?.lastOkAt).toEqual(at(3));
    await recordServiceOk(db, 'payments:chapa', at(4));
    expect((await row('payments:chapa'))?.lastOkAt).toEqual(at(4));
  });

  it('records the outage the owner was told about, and clears it', async () => {
    const db = s.handle.db;
    await setServiceAlerted(db, 'mrz', at(5), at(6));
    expect((await row('mrz'))?.alertedDownSince).toEqual(at(5));
    await setServiceAlerted(db, 'mrz', null, at(20));
    expect((await row('mrz'))?.alertedDownSince).toBeNull();
  });

  it('judges a feed source by its runs: two failed in a row and no success since', async () => {
    const db = s.handle.db;
    await addSource(db, 'svc-a');
    await addRun(db, 'svc-a', 'ok', at(0));
    await addRun(db, 'svc-a', 'failed', at(10));
    let report = (await sourceRunReports(db)).find((r) => r.service === 'source:svc-a');
    expect(report).toMatchObject({ lastOkAt: at(0), failingSince: null });
    await addRun(db, 'svc-a', 'blocked', at(20));
    report = (await sourceRunReports(db)).find((r) => r.service === 'source:svc-a');
    expect(report).toMatchObject({
      sourceName: 'Source svc-a',
      lastOkAt: at(0),
      failingSince: at(10),
    });
    await addRun(db, 'svc-a', 'ok', at(30));
    report = (await sourceRunReports(db)).find((r) => r.service === 'source:svc-a');
    expect(report).toMatchObject({ lastOkAt: at(30), failingSince: null });
    // A disabled source is not watched.
    await addSource(db, 'svc-off', { enabled: false });
    expect((await sourceRunReports(db)).some((r) => r.service === 'source:svc-off')).toBe(false);
  });
});
