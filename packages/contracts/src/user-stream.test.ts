import { describe, expect, it } from 'vitest';
import {
  USER_CHANNEL_PATTERN,
  USER_CHANNEL_PREFIX,
  USER_MESSAGE_TYPES,
  UserMessage,
  userChannel,
  userIdOfChannel,
} from './user-stream';

const USER = '0b9f3c1e-8a4d-4c2b-9e6f-1d2c3b4a5f60';

describe('per-player channel', () => {
  it('names one channel per user id, in lower case', () => {
    expect(userChannel(USER)).toBe(`vamos:user:${USER}`);
    expect(userChannel(USER.toUpperCase())).toBe(`vamos:user:${USER}`);
    expect(userChannel(USER).startsWith(USER_CHANNEL_PREFIX)).toBe(true);
    expect(USER_CHANNEL_PATTERN).toBe('vamos:user:*');
  });

  it('refuses anything but a user id, so no other channel or pattern can be named', () => {
    for (const bad of ['', '*', `${USER}*`, `${USER}:x`, 'vamos:live', '../x', `${USER} `]) {
      expect(() => userChannel(bad)).toThrow(RangeError);
    }
    expect(() => userChannel(undefined as unknown as string)).toThrow(RangeError);
  });

  it('reads the user id back from a channel name', () => {
    expect(userIdOfChannel(userChannel(USER))).toBe(USER);
    for (const other of ['vamos:live', 'vamos:user:', 'vamos:user:*', `vamos:user:${USER}:x`]) {
      expect(userIdOfChannel(other)).toBeNull();
    }
  });
});

describe('UserMessage', () => {
  it('parses every message type', () => {
    const ref = { betId: 'b1', shortId: 'ABCD2345' };
    const messages = [
      { type: 'bet.accepted', data: { ...ref, oddsChanged: false } },
      { type: 'bet.rejected', data: { ...ref, reason: 'odds_changed', refund: '5000' } },
      {
        type: 'bet.settled',
        data: {
          ...ref,
          status: 'won',
          gross: '20000',
          tax: '2000',
          net: '18000',
          corrected: false,
        },
      },
      { type: 'bet.cashed_out', data: { ...ref, gross: '15000', tax: '1000', net: '14000' } },
      { type: 'bet.reopened', data: { ...ref } },
      { type: 'wallet.changed', data: { cash: '123456', bonus: '0' } },
    ];
    for (const message of messages) expect(UserMessage.parse(message)).toEqual(message);
    expect(messages.map((m) => m.type)).toEqual([...USER_MESSAGE_TYPES]);
  });

  it('lists every type of the union', () => {
    const unionTypes = UserMessage.options.map((option) => option.shape.type.value);
    expect([...unionTypes].sort()).toEqual([...USER_MESSAGE_TYPES].sort());
  });

  it('rejects unknown types and money that is not santim', () => {
    expect(UserMessage.safeParse({ type: 'bet.unknown', data: {} }).success).toBe(false);
    expect(
      UserMessage.safeParse({ type: 'wallet.changed', data: { cash: 12.5, bonus: '0' } }).success,
    ).toBe(false);
    expect(
      UserMessage.safeParse({
        type: 'bet.settled',
        data: {
          betId: 'b',
          shortId: 's',
          status: 'cashed_out',
          gross: '0',
          tax: '0',
          net: '0',
          corrected: false,
        },
      }).success,
    ).toBe(false);
  });
});
