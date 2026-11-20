import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeUcs2Hex } from '../src/at/codec';
import { runTransfer, type RunResult } from '../src/runner';
import { SIM_WALLET_SCRIPT, type MenuFault, type SimWallet } from '../src/sim/wallet-menu';
import { NO_PIN, pinOf, rig, TRANSFER, type RigOptions } from './helpers';

const LOCAL = '0911234567';

async function send(
  options: RigOptions = {},
  transfer = TRANSFER,
  mode: 'send' | 'rehearse' = 'send',
) {
  const r = await rig(options);
  const result = await runTransfer({
    session: r.session,
    script: SIM_WALLET_SCRIPT,
    transfer,
    mode,
    pin: pinOf(r.wallet),
  });
  return { ...r, result };
}

/** Everything the agent keeps or reports about a run, as text: the PIN must be in none of it. */
const reported = (result: RunResult, trace: string[]) =>
  JSON.stringify({ result, trace }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : (v as unknown),
  );

function expectNoPin(wallet: SimWallet, result: RunResult, trace: string[]) {
  const text = reported(result, trace);
  expect(text).not.toContain(wallet.pin);
  expect(text).not.toContain(encodeUcs2Hex(wallet.pin));
}

describe('runTransfer: a transfer that goes through', () => {
  it('sends once, to the right number, for the right amount, and reports the reference', async () => {
    const { wallet, result, modem, trace } = await send();
    expect(result.outcome).toBe('sent');
    expect(result.reference).toBe('SIM0000001');
    expect(wallet.transfers).toEqual([{ to: LOCAL, amount: 150_000n, reference: 'SIM0000001' }]);
    expect(wallet.pinsTyped).toBe(1);
    // The PIN went to the modem once, and is nowhere in what the agent keeps.
    const pinCommand = `AT+CUSD=1,"${encodeUcs2Hex(wallet.pin)}",15`;
    expect(modem.commands.filter((command) => command === pinCommand)).toHaveLength(1);
    expectNoPin(wallet, result, trace);
    expect(result.transcript.filter((e) => e.kind === 'typed').map((e) => e.text)).toEqual([
      '*127#',
      '1',
      LOCAL,
      '1500',
      '1',
      '<PIN>',
    ]);
    expect(result.transcript.at(-2)).toEqual({ kind: 'typed', text: '<PIN>', commit: true });
  });

  it('works with a modem that sends plain text with line breaks, in pieces, the screen before its OK', async () => {
    for (const options of [
      { charset: 'GSM' as const },
      { modem: { fragment: (text: string) => text.match(/[\s\S]{1,3}/g) ?? [] } },
      { modem: { screenBeforeOk: true } },
      { charset: 'GSM' as const, modem: { screenBeforeOk: true, fragment: (t: string) => [...t] } },
    ]) {
      const { wallet, result } = await send(options);
      expect(result.outcome, JSON.stringify(options)).toBe('sent');
      expect(wallet.transfers).toHaveLength(1);
    }
  });

  it('two transfers in a row use two sessions', async () => {
    const r = await rig();
    const run = (amount: bigint) =>
      runTransfer({
        session: r.session,
        script: SIM_WALLET_SCRIPT,
        transfer: { ...TRANSFER, amount },
        mode: 'send',
        pin: pinOf(r.wallet),
      });
    expect((await run(10_000n)).outcome).toBe('sent');
    expect((await run(20_000n)).outcome).toBe('sent');
    expect(r.wallet.transfers.map((t) => t.amount)).toEqual([10_000n, 20_000n]);
  });
});

describe('runTransfer: a rehearsal', () => {
  it('walks the menu to the commit, types no PIN, moves no money and hangs up', async () => {
    const { wallet, result, modem } = await send({}, TRANSFER, 'rehearse');
    expect(result).toMatchObject({ outcome: 'rehearsed', reason: null, reference: null });
    expect(wallet.transfers).toEqual([]);
    expect(wallet.pinsTyped).toBe(0);
    expect(modem.commands.at(-1)).toBe('AT+CUSD=2');
    expect(result.transcript.at(-1)).toEqual({ kind: 'screen', text: 'Enter PIN', open: true });
  });

  it('reports a menu that does not match the script as not sent', async () => {
    const { wallet, result } = await send(
      { fault: { at: 2, kind: 'garbage' } },
      TRANSFER,
      'rehearse',
    );
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'unexpected_screen' });
    expect(wallet.transfers).toEqual([]);
  });
});

describe('runTransfer: stopping before the money moves', () => {
  const stopped = async (options: RigOptions, transfer = TRANSFER) => {
    const { wallet, result, trace } = await send(options, transfer);
    expect(wallet.transfers).toEqual([]);
    expect(wallet.pinsTyped).toBe(0);
    expectNoPin(wallet, result, trace);
    return result;
  };

  it('a number the wallet does not know', async () => {
    const result = await stopped({}, { ...TRANSFER, number: '+251955000111' });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'unexpected_screen' });
  });

  it("a wallet registered in another person's name", async () => {
    const result = await stopped({}, { ...TRANSFER, name: 'Sara Haile' });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'name_differs' });
  });

  it('a menu that took another amount or another number than the one typed', async () => {
    expect(await stopped({ quirks: { takesAmount: (typed) => typed * 10n } })).toMatchObject({
      outcome: 'not_sent',
      reason: 'amount_differs',
    });
    expect(await stopped({ quirks: { takesAmount: (typed) => typed + 1n } })).toMatchObject({
      outcome: 'not_sent',
      reason: 'amount_differs',
    });
    expect(await stopped({ quirks: { takesNumber: () => '0922334455' } })).toMatchObject({
      outcome: 'not_sent',
    });
  });

  it('an amount the menu cannot be given (santim in a whole-birr menu): nothing is even dialled', async () => {
    const { modem, result } = await send({}, { ...TRANSFER, amount: 150_050n });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'amount_not_whole_birr' });
    expect(modem.commands.some((command) => command.startsWith('AT+CUSD'))).toBe(false);
  });

  it('no PIN in memory: the session is cancelled at the PIN screen', async () => {
    const r = await rig();
    const result = await runTransfer({
      session: r.session,
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: NO_PIN,
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'no_pin' });
    expect(r.wallet.pinsTyped).toBe(0);
    expect(r.modem.commands.at(-1)).toBe('AT+CUSD=2');
  });

  it('a PIN that is not digits is never typed', async () => {
    const r = await rig();
    const result = await runTransfer({
      session: r.session,
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: { get: () => '12ab' },
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'no_pin' });
    expect(r.wallet.pinsTyped).toBe(0);
  });
});

describe('runTransfer: results after the PIN', () => {
  it('a wrong PIN is a certain failure', async () => {
    const r = await rig();
    const result = await runTransfer({
      session: r.session,
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: { get: () => '000000' },
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'failed_wrong_pin' });
    expect(r.wallet.transfers).toEqual([]);
    expect(r.wallet.wrongPins).toBe(1);
    expect(JSON.stringify(result.transcript)).not.toContain('000000');
  });

  it('a balance too low is a certain failure', async () => {
    const { wallet, result } = await send({ wallet: { balance: 100_000n } });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'failed_insufficient_balance' });
    expect(wallet.transfers).toEqual([]);
  });
});

describe('runTransfer: a session that breaks', () => {
  const KINDS: MenuFault['kind'][] = [
    'silent',
    'silent_after_effect',
    'garbage',
    'terminate',
    'modem_error',
  ];
  // Exchange 0 is the dial, 1 to 4 the answers before the PIN, 5 the PIN (the commit).
  for (const kind of KINDS) {
    for (let at = 0; at <= 5; at += 1) {
      it(`${kind} at exchange ${at}`, async () => {
        const { wallet, result, trace, modem } = await send({ fault: { at, kind } });
        expectNoPin(wallet, result, trace);
        expect(result.outcome).not.toBe('sent');
        if (at < 5) {
          // The commit was never typed: certainly nothing sent.
          expect(result.outcome).toBe('not_sent');
          expect(wallet.transfers).toEqual([]);
          expect(wallet.pinsTyped).toBe(0);
        } else {
          // The PIN was typed and no result we know came back: a person must look.
          expect(result.outcome).toBe('unknown');
          // Only when the menu acted on the PIN and its answer was lost did the money move.
          expect(wallet.transfers).toHaveLength(kind === 'silent_after_effect' ? 1 : 0);
        }
        // Whatever happened, the session was hung up.
        expect(modem.commands.at(-1)).toBe('AT+CUSD=2');
      });
    }
  }

  it('a late screen of an earlier session, read as the first screen, stops with nothing sent', async () => {
    const r = await rig();
    r.modem.unsolicited(
      r.modem.cusdLine(
        0,
        'You have sent 1500.00 Birr to 0911234567. Transaction OLD0000001. Balance 1.00 Birr',
      ),
    );
    const result = await runTransfer({
      session: r.session,
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: pinOf(r.wallet),
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'unexpected_screen' });
    expect(r.wallet.transfers).toEqual([]);
    // The next attempt starts clean.
    const again = await runTransfer({
      session: r.session,
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: pinOf(r.wallet),
    });
    expect(again.outcome).toBe('sent');
    expect(r.wallet.transfers).toHaveLength(1);
  });

  it('never answers a screen that closed the session', async () => {
    const typed: string[] = [];
    let cancelled = 0;
    const result = await runTransfer({
      session: {
        // The right first screen, but the network says it was its last word.
        dial: async () => ({
          text: 'Welcome to telebirr 1. Send Money 2. Buy Airtime 3. My Account',
          open: false,
        }),
        reply: async (text) => {
          typed.push(text);
          return { text: 'Enter mobile number', open: true };
        },
        cancel: async () => {
          cancelled += 1;
        },
      },
      script: SIM_WALLET_SCRIPT,
      transfer: TRANSFER,
      mode: 'send',
      pin: { get: () => '482913' },
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'session_lost:closed_early' });
    expect(typed).toEqual([]);
    expect(cancelled).toBe(1);
  });

  it('a script that is not valid sends nothing and dials nothing', async () => {
    const r = await rig();
    const result = await runTransfer({
      session: r.session,
      script: { ...SIM_WALLET_SCRIPT, steps: SIM_WALLET_SCRIPT.steps.slice(0, 4) },
      transfer: TRANSFER,
      mode: 'send',
      pin: pinOf(r.wallet),
    });
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'invalid_script' });
    expect(r.modem.commands.some((command) => command.startsWith('AT+CUSD'))).toBe(false);
  });
});

describe('runTransfer: what is reported is what happened', () => {
  it('for any fault, quirk and modem behaviour', async () => {
    const faultArb = fc.option(
      fc.record({
        at: fc.integer({ min: 0, max: 6 }),
        kind: fc.constantFrom<MenuFault['kind']>(
          'silent',
          'silent_after_effect',
          'garbage',
          'terminate',
          'modem_error',
        ),
      }),
      { nil: null },
    );
    const quirkArb = fc.constantFrom('none', 'amount', 'number', 'name', 'poor', 'wrong_pin');
    await fc.assert(
      fc.asyncProperty(
        faultArb,
        quirkArb,
        fc.constantFrom<'UCS2' | 'GSM'>('UCS2', 'GSM'),
        fc.boolean(),
        fc.integer({ min: 0, max: 7 }),
        fc.constantFrom<'send' | 'rehearse'>('send', 'send', 'send', 'rehearse'),
        fc.integer({ min: 1, max: 9_000 }),
        async (fault, quirk, charset, screenBeforeOk, pieces, mode, birr) => {
          const amount = BigInt(birr) * 100n;
          const transfer = {
            ...TRANSFER,
            amount,
            name: quirk === 'name' ? 'Sara Haile' : TRANSFER.name,
          };
          const r = await rig({
            fault,
            charset,
            stepTimeoutMs: 25,
            quirks:
              quirk === 'amount'
                ? { takesAmount: (typed) => typed + 100n }
                : quirk === 'number'
                  ? { takesNumber: () => '0922334455' }
                  : {},
            wallet: quirk === 'poor' ? { balance: 50n } : {},
            modem: {
              screenBeforeOk,
              ...(pieces === 0
                ? {}
                : {
                    fragment: (t: string) =>
                      t.match(new RegExp(`[\\s\\S]{1,${pieces}}`, 'g')) ?? [],
                  }),
            },
          });
          const result = await runTransfer({
            session: r.session,
            script: SIM_WALLET_SCRIPT,
            transfer,
            mode,
            pin: quirk === 'wrong_pin' ? { get: () => '111111' } : pinOf(r.wallet),
          });
          const made = r.wallet.transfers;
          const right = { to: LOCAL, amount };

          // Never two transfers, never one to another number or for another amount.
          expect(made.length).toBeLessThanOrEqual(1);
          for (const transferMade of made) expect(transferMade).toMatchObject(right);
          if (result.outcome === 'sent') {
            expect(made).toEqual([{ ...right, reference: result.reference }]);
            expect(mode).toBe('send');
          } else if (result.outcome === 'not_sent' || result.outcome === 'rehearsed') {
            // "Nothing was sent" must be true: the server may retry or release on this word.
            expect(made).toEqual([]);
          }
          // Money moved without a clear result: the only word allowed is "unknown".
          if (made.length === 1 && result.outcome !== 'sent')
            expect(result.outcome).toBe('unknown');
          if (mode === 'rehearse') expect(r.wallet.pinsTyped).toBe(0);
          // A menu showing another number, amount or name never gets the PIN.
          if (quirk === 'amount' || quirk === 'number' || quirk === 'name') {
            expect(r.wallet.pinsTyped).toBe(0);
          }
          expectNoPin(r.wallet, result, r.trace);
          expect(reported(result, r.trace)).not.toContain('111111');
        },
      ),
      { numRuns: 150 },
    );
  });
});
