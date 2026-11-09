import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reconcileBalances, signedSmsAmount, type BalanceObservation } from './balancechain';

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 28, 10, minutes));

function obs(
  balance: bigint,
  amount: bigint,
  direction: 'credit' | 'debit',
  minutes: number,
): BalanceObservation {
  return { balance, amount, direction, at: at(minutes) };
}

describe('reconcileBalances', () => {
  it('needs two observations', () => {
    expect(reconcileBalances([])).toEqual({ status: 'insufficient_data', observations: 0 });
    expect(reconcileBalances([obs(1000n, 100n, 'credit', 0)]).status).toBe('insufficient_data');
  });

  it('reconciles credits and debits', () => {
    expect(
      reconcileBalances([
        obs(1000n, 50n, 'credit', 0),
        obs(1500n, 500n, 'credit', 1),
        obs(1300n, 200n, 'debit', 2),
      ]),
    ).toEqual({ status: 'consistent', observations: 3, movement: 300n });
  });

  it('names a credit that never arrived (the forgery signature)', () => {
    expect(
      reconcileBalances([obs(1000n, 50n, 'credit', 0), obs(1100n, 900n, 'credit', 1)]),
    ).toEqual({
      status: 'drift',
      observations: 2,
      expected: 900n,
      actual: 100n,
      drift: -800n,
      direction: 'credited_more_than_arrived',
    });
  });

  it('names missed incoming messages', () => {
    expect(
      reconcileBalances([obs(1000n, 50n, 'credit', 0), obs(5000n, 500n, 'credit', 1)]),
    ).toMatchObject({ drift: 3500n, direction: 'missed_incoming' });
  });

  it('does not count the anchor’s own amount', () => {
    expect(
      reconcileBalances([obs(1000n, 999n, 'credit', 0), obs(1100n, 100n, 'credit', 1)]).status,
    ).toBe('consistent');
  });

  it('treats credits as positive and debits as negative', () => {
    expect(signedSmsAmount({ amount: 5n, direction: 'credit' })).toBe(5n);
    expect(signedSmsAmount({ amount: 5n, direction: 'debit' })).toBe(-5n);
  });

  const genuineRun = fc
    .tuple(
      fc.bigInt({ min: 0n, max: 10n ** 9n }),
      fc.array(
        fc.record({
          amount: fc.bigInt({ min: 1n, max: 10n ** 6n }),
          direction: fc.constantFrom('credit' as const, 'debit' as const),
        }),
        { minLength: 1, maxLength: 20 },
      ),
    )
    .map(([opening, moves]) => {
      let balance = opening + 10n ** 8n;
      const list: BalanceObservation[] = [obs(balance, 1n, 'credit', 0)];
      moves.forEach((move, i) => {
        balance += signedSmsAmount(move);
        list.push({ ...move, balance, at: at(i + 1) });
      });
      return list;
    });

  it('a genuine run is consistent in any delivery order', () => {
    fc.assert(
      fc.property(genuineRun, fc.integer(), (list, seed) => {
        const shuffled = [...list].sort(
          (a, b) => ((a.at.getTime() * 31 + seed) % 97) - ((b.at.getTime() * 31 + seed) % 97),
        );
        return reconcileBalances(shuffled).status === 'consistent';
      }),
    );
  });

  it('a forged credit inserted into a genuine run shows as drift of exactly its amount', () => {
    fc.assert(
      fc.property(genuineRun, fc.bigInt({ min: 1n, max: 10n ** 6n }), (list, forged) => {
        // The forger invents the balance they would have had; the next genuine
        // message still carries the real one, so the run no longer adds up.
        const anchor = list[0]!;
        const withForgery = [
          ...list,
          {
            balance: anchor.balance + forged,
            amount: forged,
            direction: 'credit' as const,
            at: new Date(anchor.at.getTime() + 30_000),
          },
        ];
        const result = reconcileBalances(withForgery);
        return result.status === 'drift' && result.drift === -forged;
      }),
    );
  });
});
