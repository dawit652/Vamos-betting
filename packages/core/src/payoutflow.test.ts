import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assessManualPayout } from './payoutflow';

describe('assessManualPayout', () => {
  it('approves a requested payout', () => {
    expect(
      assessManualPayout({ status: 'requested', action: 'approve', actor: 'a', approvedBy: null }),
    ).toEqual({
      ok: true,
      next: 'approved',
    });
  });

  it('lets a second person settle an approved payout', () => {
    expect(
      assessManualPayout({ status: 'approved', action: 'settle', actor: 'b', approvedBy: 'a' }),
    ).toEqual({
      ok: true,
      next: 'paid',
    });
  });

  it('refuses the approver as the settler', () => {
    expect(
      assessManualPayout({ status: 'approved', action: 'settle', actor: 'a', approvedBy: 'a' }),
    ).toEqual({
      ok: false,
      reason: 'same_actor_approved_and_settled',
    });
  });

  it('refuses to settle what nobody approved', () => {
    expect(
      assessManualPayout({ status: 'requested', action: 'settle', actor: 'b', approvedBy: null }),
    ).toEqual({
      ok: false,
      reason: 'wrong_status',
    });
  });

  it('refuses to reject a paid payout', () => {
    expect(
      assessManualPayout({ status: 'paid', action: 'reject', actor: 'a', approvedBy: 'a' }).ok,
    ).toBe(false);
  });

  it('never lets one actor both approve and settle', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('approved', 'processing'), (actor, status) => {
        return !assessManualPayout({ status, action: 'settle', actor, approvedBy: actor }).ok;
      }),
    );
  });
});
