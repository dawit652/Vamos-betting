import type { UserMessage } from '@vamos/contracts';
import { lookup, MESSAGES } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { describeUserMessage, parseUserFrame, USER_MESSAGE_TYPES } from './messages';

const ref = { betId: 'bet-1', shortId: 'AB12CD' };

describe('parseUserFrame', () => {
  it('parses every message type from its data body', () => {
    expect(parseUserFrame('bet.accepted', JSON.stringify({ ...ref, oddsChanged: true }))).toEqual({
      type: 'bet.accepted',
      data: { ...ref, oddsChanged: true },
    });
    expect(
      parseUserFrame(
        'bet.rejected',
        JSON.stringify({ ...ref, reason: 'odds_changed', refund: '1000' }),
      ),
    ).toEqual({ type: 'bet.rejected', data: { ...ref, reason: 'odds_changed', refund: '1000' } });
    const settled = {
      ...ref,
      status: 'won',
      gross: '500',
      tax: '50',
      net: '450',
      corrected: false,
    };
    expect(parseUserFrame('bet.settled', JSON.stringify(settled))).toEqual({
      type: 'bet.settled',
      data: settled,
    });
    const cashed = { ...ref, gross: '500', tax: '0', net: '500' };
    expect(parseUserFrame('bet.cashed_out', JSON.stringify(cashed))?.type).toBe('bet.cashed_out');
    expect(parseUserFrame('bet.reopened', JSON.stringify(ref))?.type).toBe('bet.reopened');
    expect(parseUserFrame('wallet.changed', JSON.stringify({ cash: '1', bonus: '0' }))?.type).toBe(
      'wallet.changed',
    );
    expect(USER_MESSAGE_TYPES).toHaveLength(6);
  });

  it('accepts the { type, data } envelope too, but only when the type matches', () => {
    const body = JSON.stringify({ type: 'bet.reopened', data: ref });
    expect(parseUserFrame('bet.reopened', body)?.type).toBe('bet.reopened');
    expect(parseUserFrame('bet.accepted', body)).toBeNull();
  });

  it('rejects malformed frames', () => {
    expect(parseUserFrame('bet.accepted', 'not json')).toBeNull();
    expect(parseUserFrame('bet.accepted', '[]')).toBeNull();
    expect(parseUserFrame('bet.accepted', JSON.stringify(ref))).toBeNull();
    expect(parseUserFrame('wallet.changed', JSON.stringify({ cash: 12, bonus: '0' }))).toBeNull();
    expect(
      parseUserFrame(
        'bet.settled',
        JSON.stringify({
          ...ref,
          status: 'weird',
          gross: '0',
          tax: '0',
          net: '0',
          corrected: false,
        }),
      ),
    ).toBeNull();
    expect(parseUserFrame('unknown', JSON.stringify(ref))).toBeNull();
  });
});

describe('describeUserMessage', () => {
  it('toasts a settled bet and refreshes the balance', () => {
    const effect = describeUserMessage({
      type: 'bet.settled',
      data: { ...ref, status: 'won', gross: '1000', tax: '100', net: '900', corrected: false },
    });
    expect(effect.betId).toBe('bet-1');
    expect(effect.refreshWallet).toBe(true);
    expect(effect.toast).toEqual({
      key: 'account.notify.won',
      params: { id: 'AB12CD', net: 'ETB 9.00' },
      tone: 'success',
    });
  });

  it('uses the correction texts for a corrected settlement', () => {
    const effect = describeUserMessage({
      type: 'bet.settled',
      data: { ...ref, status: 'lost', gross: '0', tax: '0', net: '0', corrected: true },
    });
    expect(effect.toast?.key).toBe('account.notify.correctedLost');
    expect(effect.toast?.tone).toBe('info');
  });

  it('distinguishes accepted at changed odds, rejected and cashed out', () => {
    expect(
      describeUserMessage({ type: 'bet.accepted', data: { ...ref, oddsChanged: true } }).toast?.key,
    ).toBe('account.notify.acceptedOddsChanged');
    const rejected = describeUserMessage({
      type: 'bet.rejected',
      data: { ...ref, reason: 'odds_changed', refund: '2500' },
    });
    expect(rejected.toast).toMatchObject({ key: 'account.notify.rejected', tone: 'error' });
    expect(rejected.toast?.params.refund).toBe('ETB 25.00');
    expect(
      describeUserMessage({
        type: 'bet.cashed_out',
        data: { ...ref, gross: '1', tax: '0', net: '1' },
      }).toast?.key,
    ).toBe('account.notify.cashedOut');
  });

  it('wallet messages only refresh the balance', () => {
    expect(
      describeUserMessage({ type: 'wallet.changed', data: { cash: '1', bonus: '0' } }),
    ).toEqual({
      betId: null,
      refreshWallet: true,
      toast: null,
    });
  });
});

describe('toast texts', () => {
  it('exist in English and Amharic with the placeholders the toast fills', () => {
    const messages: UserMessage[] = [
      { type: 'bet.accepted', data: { ...ref, oddsChanged: false } },
      { type: 'bet.accepted', data: { ...ref, oddsChanged: true } },
      { type: 'bet.rejected', data: { ...ref, reason: 'x', refund: '1' } },
      { type: 'bet.cashed_out', data: { ...ref, gross: '1', tax: '0', net: '1' } },
      { type: 'bet.reopened', data: ref },
      ...(['won', 'lost', 'void'] as const).flatMap((status) =>
        [false, true].map((corrected): UserMessage => ({
          type: 'bet.settled',
          data: { ...ref, status, gross: '1', tax: '0', net: '1', corrected },
        })),
      ),
    ];
    for (const message of messages) {
      const toast = describeUserMessage(message).toast!;
      for (const locale of ['en', 'am'] as const) {
        const text = lookup(MESSAGES[locale], toast.key);
        expect(text, toast.key).toBeTypeOf('string');
        for (const [, name] of (text as string).matchAll(/\{(\w+)\}/g)) {
          expect(Object.keys(toast.params), `${locale} ${toast.key}`).toContain(name);
        }
      }
    }
  });
});
