import { deriveMenuScript, type PayoutMenuScript } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { encodeUcs2Hex } from '../src/at/codec';
import { recordSession, type RecordAnswer } from '../src/record';
import { runTransfer } from '../src/runner';
import { SIM_WALLET_SCRIPT, type SimWallet } from '../src/sim/wallet-menu';
import type { UssdScreen } from '../src/ussd/session';
import { pinOf, rig, type RigOptions } from './helpers';

/** The owner at the keyboard: answers each screen of the invented menu as they would on the phone. */
type Asker = (wallet: SimWallet) => (screen: UssdScreen) => Promise<RecordAnswer>;

const owner: Asker = (wallet) => async (screen) => {
  if (screen.text.startsWith('Welcome')) return { kind: 'keys', text: '1' };
  if (screen.text === 'Enter mobile number') return { kind: 'number' };
  if (screen.text === 'Enter amount') return { kind: 'amount' };
  if (screen.text.startsWith('Send ')) return { kind: 'keys', text: '1' };
  if (screen.text === 'Enter PIN') return { kind: 'pin', pin: wallet.pin };
  return { kind: 'abort' };
};

async function record(options: RigOptions = {}, ask: Asker = owner) {
  const r = await rig(options);
  const result = await recordSession({
    session: r.session,
    institution: 'telebirr',
    dial: '*127#',
    numberFormat: 'local',
    amountFormat: 'whole_birr',
    number: '+251911234567',
    amount: 1_500n,
    shownName: 'ABEBE KEBEDE',
    ask: ask(r.wallet),
  });
  return { ...r, result };
}

async function taught(): Promise<PayoutMenuScript> {
  const { result } = await record();
  if (!result.ok) throw new Error(result.reason);
  const derived = deriveMenuScript(result.recording);
  if (!derived.ok) throw new Error(derived.problems.join('; '));
  return derived.script;
}

describe('recordSession', () => {
  it('makes the one transfer, keeps every screen and never the PIN', async () => {
    const { wallet, result, trace, modem } = await record();
    if (!result.ok) throw new Error(result.reason);
    expect(wallet.transfers).toEqual([
      { to: '0911234567', amount: 1_500n, reference: 'SIM0000001' },
    ]);
    expect(result.recording.exchanges.map((e) => e.typed)).toEqual([
      { keys: '1' },
      { value: 'number' },
      { value: 'amount' },
      { keys: '1' },
      { pin: true },
    ]);
    expect(result.recording.result).toMatch(/^You have sent 15\.00 Birr to 0911234567/);
    const kept = JSON.stringify({ recording: result.recording, trace }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : (v as unknown),
    );
    expect(kept).not.toContain(wallet.pin);
    expect(kept).not.toContain(encodeUcs2Hex(wallet.pin));
    expect(modem.commands.at(-1)).toBe('AT+CUSD=2');
  });

  it('gives up cleanly: the session is cancelled, nothing is recorded, no PIN was typed', async () => {
    const { wallet, result, modem } = await record(
      {},
      (w) => async (screen) =>
        screen.text === 'Enter amount' ? { kind: 'abort' } : owner(w)(screen),
    );
    expect(result).toEqual({ ok: false, reason: 'given up' });
    expect(wallet.transfers).toEqual([]);
    expect(wallet.pinsTyped).toBe(0);
    expect(modem.commands.at(-1)).toBe('AT+CUSD=2');
  });

  it('refuses answers and PINs that are not keys of a phone', async () => {
    const bad = await record({}, () => async () => ({ kind: 'keys', text: 'yes' }));
    expect(bad.result).toEqual({ ok: false, reason: 'an answer is 1 to 20 of 0-9 * #' });
    const { wallet, result } = await record(
      {},
      (w) => async (screen) =>
        screen.text === 'Enter PIN' ? { kind: 'pin', pin: 'abcd' } : owner(w)(screen),
    );
    expect(result).toEqual({ ok: false, reason: 'a PIN is 4 to 8 digits' });
    expect(wallet.pinsTyped).toBe(0);
  });

  it("says so when the session breaks, without the modem's own words", async () => {
    const { result } = await record({ fault: { at: 2, kind: 'modem_error' } });
    expect(result).toEqual({
      ok: false,
      reason: 'the session broke; if the PIN had been typed, check the wallet',
    });
  });
});

describe('a script taught by one recording', () => {
  it('is the script a person would have written for this menu', async () => {
    const script = await taught();
    expect(script.steps).toEqual(SIM_WALLET_SCRIPT.steps);
    expect(script.success).toBe(SIM_WALLET_SCRIPT.success);
  });

  it('sends another amount to another person, and rehearses without the PIN', async () => {
    const script = await taught();
    const transfer = { number: '+251922334455', amount: 730_000n, name: 'Sara Haile' };
    const r = await rig();
    const sent = await runTransfer({
      session: r.session,
      script,
      transfer,
      mode: 'send',
      pin: pinOf(r.wallet),
    });
    expect(sent.outcome).toBe('sent');
    expect(r.wallet.transfers).toEqual([
      { to: '0922334455', amount: 730_000n, reference: 'SIM0000001' },
    ]);

    const rehearsed = await runTransfer({
      session: r.session,
      script,
      transfer: { ...transfer, amount: 12_300n },
      mode: 'rehearse',
      pin: pinOf(r.wallet),
    });
    expect(rehearsed.outcome).toBe('rehearsed');
    expect(r.wallet.transfers).toHaveLength(1);
    expect(r.wallet.pinsTyped).toBe(1);
  });

  it('stops where the hand-written script stops, and reports what it cannot know as unknown', async () => {
    const script = await taught();
    const transfer = { number: '+251911234567', amount: 20_000n, name: 'Abebe Kebede' };
    const run = async (options: RigOptions, pin?: string) => {
      const r = await rig(options);
      const result = await runTransfer({
        session: r.session,
        script,
        transfer,
        mode: 'send',
        pin: pin === undefined ? pinOf(r.wallet) : { get: () => pin },
      });
      return { wallet: r.wallet, result };
    };
    const drift = await run({ quirks: { takesAmount: (typed) => typed * 10n } });
    expect(drift.result).toMatchObject({ outcome: 'not_sent', reason: 'amount_differs' });
    expect(drift.wallet.pinsTyped).toBe(0);

    const lost = await run({ fault: { at: 5, kind: 'silent_after_effect' } });
    expect(lost.result.outcome).toBe('unknown');
    expect(lost.wallet.transfers).toHaveLength(1);

    // One recording knows no failure screens: a refused PIN is "unknown" until they are added.
    const wrongPin = await run({}, '000000');
    expect(wrongPin.result).toMatchObject({ outcome: 'unknown', reason: 'unexpected_result' });
    expect(wrongPin.wallet.transfers).toEqual([]);
  });
});
