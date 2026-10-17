import { describe, expect, it } from 'vitest';
import { announcing, markAnnounced, unmarkAnnounced, wasAnnounced } from './toast-bus';

describe('toast bus', () => {
  it('remembers an announced bet for a minute', () => {
    markAnnounced('bet-1', 1_000);
    expect(wasAnnounced('bet-1', 1_000)).toBe(true);
    expect(wasAnnounced('bet-1', 61_000)).toBe(true);
    expect(wasAnnounced('bet-1', 61_001)).toBe(false);
    expect(wasAnnounced('bet-2', 1_000)).toBe(false);
    markAnnounced('bet-3');
    unmarkAnnounced('bet-3');
    expect(wasAnnounced('bet-3')).toBe(false);
  });

  it('marks the bet before the request goes out: a push that beats the response is not toasted', async () => {
    let duringRequest: boolean | null = null;
    const result = await announcing('bet-4', async () => {
      // The bet.cashed_out push can arrive here, before the HTTP response.
      duringRequest = wasAnnounced('bet-4');
      return 'paid';
    });
    expect(result).toBe('paid');
    expect(duringRequest).toBe(true);
    expect(wasAnnounced('bet-4')).toBe(true);
  });

  it('clears the mark when the request fails, so a push about the bet is shown', async () => {
    await expect(
      announcing('bet-5', () => Promise.reject(new Error('409 cashout_offer_changed'))),
    ).rejects.toThrow('409');
    expect(wasAnnounced('bet-5')).toBe(false);
  });
});
