import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assessManualPayout, type ManualPayoutAction } from './payoutflow';

const base = { actor: 'op', approvedBy: 'admin', payingBy: null as string | null };

describe('assessManualPayout', () => {
  it('walks the happy path: approve, claim, settle', () => {
    expect(
      assessManualPayout({
        ...base,
        status: 'requested',
        action: 'approve',
        actor: 'admin',
        approvedBy: null,
      }),
    ).toEqual({ ok: true, next: 'approved' });
    expect(assessManualPayout({ ...base, status: 'approved', action: 'claim' })).toEqual({
      ok: true,
      next: 'processing',
    });
    expect(
      assessManualPayout({ ...base, status: 'processing', action: 'settle', payingBy: 'op' }),
    ).toEqual({ ok: true, next: 'paid' });
  });

  it('refuses the approver as the payer', () => {
    expect(
      assessManualPayout({ ...base, status: 'approved', action: 'claim', actor: 'admin' }),
    ).toEqual({ ok: false, reason: 'approver_cannot_pay' });
    expect(
      assessManualPayout({
        ...base,
        status: 'processing',
        action: 'settle',
        actor: 'admin',
        payingBy: 'admin',
      }),
    ).toEqual({ ok: false, reason: 'approver_cannot_pay' });
  });

  it('lets only the claimer settle, release or fail a claimed payout', () => {
    for (const action of ['settle', 'release', 'fail'] as const) {
      expect(
        assessManualPayout({ ...base, status: 'processing', action, payingBy: 'someone-else' }),
      ).toEqual({ ok: false, reason: 'claimed_by_someone_else' });
    }
    expect(
      assessManualPayout({ ...base, status: 'processing', action: 'release', payingBy: 'op' }),
    ).toEqual({ ok: true, next: 'approved' });
  });

  it('refuses to settle what nobody claimed or approved', () => {
    expect(assessManualPayout({ ...base, status: 'approved', action: 'settle' })).toEqual({
      ok: false,
      reason: 'wrong_status',
    });
    expect(assessManualPayout({ ...base, status: 'requested', action: 'claim' }).ok).toBe(false);
  });

  it('cannot reject a payout an operator is paying', () => {
    expect(assessManualPayout({ ...base, status: 'processing', action: 'reject' }).ok).toBe(false);
  });

  it('lets an auto-approved payout be claimed by anyone', () => {
    expect(
      assessManualPayout({
        ...base,
        status: 'approved',
        action: 'claim',
        approvedBy: 'system:auto',
      }).ok,
    ).toBe(true);
  });

  it('never lets one person approve and pay', () => {
    const actions: ManualPayoutAction[] = ['claim', 'settle'];
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom(...actions),
        fc.constantFrom('approved', 'processing'),
        (actor, action, status) =>
          !assessManualPayout({ status, action, actor, approvedBy: actor, payingBy: actor }).ok,
      ),
    );
  });

  it('only ever pays out from processing, as the claimer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('requested', 'approved', 'processing', 'paid', 'failed', 'rejected'),
        fc.constantFrom('a', 'b', 'c'),
        fc.option(fc.constantFrom('a', 'b', 'c')),
        fc.option(fc.constantFrom('a', 'b', 'c')),
        (status, actor, approvedBy, payingBy) => {
          const verdict = assessManualPayout({
            status,
            action: 'settle',
            actor,
            approvedBy,
            payingBy,
          });
          return (
            !verdict.ok || (status === 'processing' && payingBy === actor && approvedBy !== actor)
          );
        },
      ),
    );
  });
});
