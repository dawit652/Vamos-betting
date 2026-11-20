import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assessManualPayout, type ManualPayoutAction } from './payoutflow';
import { AUTO_SETTLE_ACTOR } from './payoutproof';

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

describe('assessManualPayout: auto_settle and the human settle', () => {
  const STATUSES = ['requested', 'approved', 'processing', 'paid', 'failed', 'rejected'] as const;
  const claimed = { status: 'processing', approvedBy: 'admin', payingBy: 'op' } as const;

  it('lets the double-proof actor settle a payout a person claimed', () => {
    expect(
      assessManualPayout({ ...claimed, action: 'auto_settle', actor: AUTO_SETTLE_ACTOR }),
    ).toEqual({ ok: true, next: 'paid' });
    expect(
      assessManualPayout({
        ...claimed,
        action: 'auto_settle',
        actor: AUTO_SETTLE_ACTOR,
        approvedBy: 'system:auto',
      }),
    ).toEqual({ ok: true, next: 'paid' });
  });

  it('takes auto_settle only from processing', () => {
    for (const status of STATUSES) {
      const verdict = assessManualPayout({
        ...claimed,
        status,
        action: 'auto_settle',
        actor: AUTO_SETTLE_ACTOR,
      });
      expect(verdict, status).toEqual(
        status === 'processing'
          ? { ok: true, next: 'paid' }
          : { ok: false, reason: 'wrong_status' },
      );
    }
  });

  it('refuses auto_settle for every other actor: the approver, the claimer, another system actor', () => {
    for (const actor of ['admin', 'op', 'someone', 'system:auto', 'system:double_proof2', '']) {
      expect(assessManualPayout({ ...claimed, action: 'auto_settle', actor }), actor).toEqual({
        ok: false,
        reason: 'not_automatic',
      });
    }
  });

  it('refuses auto_settle when the claimer is missing, the approver, or not a person', () => {
    const auto = { ...claimed, action: 'auto_settle', actor: AUTO_SETTLE_ACTOR } as const;
    expect(assessManualPayout({ ...auto, payingBy: null })).toEqual({
      ok: false,
      reason: 'wrong_status',
    });
    expect(assessManualPayout({ ...auto, approvedBy: null })).toEqual({
      ok: false,
      reason: 'wrong_status',
    });
    expect(assessManualPayout({ ...auto, payingBy: 'admin' })).toEqual({
      ok: false,
      reason: 'approver_cannot_pay',
    });
    expect(assessManualPayout({ ...auto, approvedBy: AUTO_SETTLE_ACTOR })).toEqual({
      ok: false,
      reason: 'approver_cannot_pay',
    });
    for (const payingBy of ['system:auto', AUTO_SETTLE_ACTOR]) {
      expect(assessManualPayout({ ...auto, payingBy }), payingBy).toEqual({
        ok: false,
        reason: 'not_a_person',
      });
    }
  });

  it('refuses the human settle to any system actor, even one recorded as the claimer', () => {
    for (const actor of [AUTO_SETTLE_ACTOR, 'system:auto', 'system:']) {
      expect(
        assessManualPayout({ ...claimed, action: 'settle', actor, payingBy: actor }),
        actor,
      ).toEqual({ ok: false, reason: 'not_a_person' });
    }
    // The claimer acting as a person still settles by the click.
    expect(assessManualPayout({ ...claimed, action: 'settle', actor: 'op' })).toEqual({
      ok: true,
      next: 'paid',
    });
  });

  it('auto_settle succeeds exactly when the rule allows it', () => {
    const who = fc.constantFrom('admin', 'op', 'other', 'system:auto', AUTO_SETTLE_ACTOR);
    fc.assert(
      fc.property(
        fc.constantFrom(...STATUSES),
        who,
        fc.option(who),
        fc.option(who),
        (status, actor, approvedBy, payingBy) => {
          const verdict = assessManualPayout({
            status,
            action: 'auto_settle',
            actor,
            approvedBy,
            payingBy,
          });
          const allowed =
            status === 'processing' &&
            actor === AUTO_SETTLE_ACTOR &&
            approvedBy !== null &&
            approvedBy !== AUTO_SETTLE_ACTOR &&
            payingBy !== null &&
            payingBy !== approvedBy &&
            !payingBy.startsWith('system:');
          expect(verdict.ok).toBe(allowed);
        },
      ),
    );
  });

  it('never lets a system actor take the human settle', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATUSES),
        fc.string().map((s) => `system:${s}`),
        fc.option(fc.string()),
        (status, actor, approvedBy) =>
          !assessManualPayout({ status, action: 'settle', actor, approvedBy, payingBy: actor }).ok,
      ),
    );
  });
});
