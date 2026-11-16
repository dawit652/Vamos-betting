import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  matchPayoutMenuScreen,
  nextPayoutMenuAction,
  parseMenuAmount,
  payoutMenuOutcomeAfterBreak,
  validatePayoutMenuScript,
  type PayoutMenuAction,
  type PayoutMenuScript,
  type PayoutMenuTransfer,
} from './payoutmenu';

/**
 * INVENTED menus, in the shape the institutions describe (number, amount,
 * confirm, PIN). They are not recordings: the real scripts are made from the
 * real SIM (docs/plans/payout-sender-design.md, section 6).
 */
const WALLET: PayoutMenuScript = {
  institution: 'telebirr',
  version: 1,
  dial: '*127#',
  numberFormat: 'local',
  amountFormat: 'whole_birr',
  steps: [
    { screen: 'Welcome{any}1. Send Money{any}', reply: { keys: '1' } },
    { screen: 'Enter mobile number', reply: { value: 'number' } },
    { screen: 'Enter amount', reply: { value: 'amount' } },
    {
      screen: 'Send {amount} Birr to {name} {number}? Fee {any} Birr. 1. Confirm 2. Cancel',
      reply: { keys: '1' },
    },
    { screen: 'Enter PIN', reply: { pin: true } },
  ],
  success: 'You have sent {amount} Birr to {number}. Transaction {reference}.{any}',
  failures: [
    { screen: '{any}Incorrect PIN{any}', code: 'wrong_pin' },
    { screen: '{any}insufficient balance{any}', code: 'insufficient_balance' },
  ],
};

/** A bank-style menu: the PIN opens the session, the last confirmation sends. */
const BANK: PayoutMenuScript = {
  institution: 'cbe',
  version: 1,
  dial: '*847#',
  numberFormat: 'international',
  amountFormat: 'birr_and_santim',
  steps: [
    { screen: 'Enter your PIN', reply: { pin: true } },
    { screen: 'Main menu{any}3. Transfer{any}', reply: { keys: '3' } },
    { screen: 'Receiver number', reply: { value: 'number' } },
    { screen: 'Amount', reply: { value: 'amount' } },
    { screen: 'Transfer ETB {amount} to {number}. 1. OK 0. Back', reply: { keys: '1' } },
  ],
  success: 'Done. Ref {reference}',
  failures: [],
};

const TRANSFER: PayoutMenuTransfer = {
  number: '+251911234567',
  amount: 150_000n, // ETB 1,500
  name: 'Abebe Kebede Tesfaye',
};

const SCREENS = [
  'Welcome to telebirr\n1. Send Money\n2. Buy Airtime',
  'Enter mobile number',
  'Enter amount',
  'Send 1,500.00 Birr to ABEBE KEBEDE 0911234567? Fee 3.45 Birr.\n1. Confirm\n2. Cancel',
  'Enter PIN',
  'You have sent 1500.00 Birr to 0911234567. Transaction CK48XR21PQ. Balance 20,113.10 Birr',
];

const walk = (screens: readonly unknown[], transfer = TRANSFER, script = WALLET) =>
  nextPayoutMenuAction(script, transfer, screens);

describe('validatePayoutMenuScript', () => {
  const problems = (change: (s: PayoutMenuScript) => unknown) => {
    const copy = structuredClone<PayoutMenuScript>(WALLET);
    change(copy);
    return validatePayoutMenuScript(copy);
  };
  const steps = (s: PayoutMenuScript) => s.steps as PayoutMenuScript['steps'][number][];

  it('accepts a menu that confirms then asks the PIN, and one that asks the PIN first', () => {
    expect(validatePayoutMenuScript(WALLET)).toEqual([]);
    expect(validatePayoutMenuScript(BANK)).toEqual([]);
  });

  it('refuses a script that does not type the number and the amount itself, once each', () => {
    expect(problems((s) => (steps(s)[1]!.reply = { keys: '1' }))).toContain(
      'the number must be typed in exactly one step',
    );
    expect(problems((s) => (steps(s)[2]!.reply = { keys: '500' }))).toContain(
      'the amount must be typed in exactly one step',
    );
    expect(problems((s) => (steps(s)[0]!.reply = { value: 'amount' }))).toContain(
      'the amount must be typed in exactly one step',
    );
  });

  it('refuses a script without exactly one PIN step', () => {
    expect(problems((s) => (steps(s)[4]!.reply = { keys: '1' }))).toContain(
      'the PIN must be typed in exactly one step',
    );
    expect(problems((s) => (steps(s)[0]!.reply = { pin: true }))).toContain(
      'the PIN must be typed in exactly one step',
    );
  });

  it('refuses a script that is never shown the number and the amount back before it commits', () => {
    const missing =
      'no screen after the number and the amount were typed shows both {number} and {amount} back';
    expect(problems((s) => (steps(s)[3]!.screen = 'Send {amount} Birr? 1. Confirm'))).toContain(
      missing,
    );
    expect(problems((s) => (steps(s)[3]!.screen = 'Send to {number}? 1. Confirm'))).toContain(
      missing,
    );
    // A screen that "shows" them before they were typed proves nothing.
    expect(
      problems((s) => {
        steps(s)[1]!.screen = 'Enter number {number} {amount}';
        steps(s)[3]!.screen = 'Are you sure? 1. Confirm';
      }),
    ).toContain(missing);
  });

  it('refuses a step after the one that sends the money', () => {
    // An extra "press 0 to exit" step: the success screen would be read as an ordinary screen
    // and a transfer that went through would be reported as not sent.
    expect(
      problems((s) =>
        steps(s).push({ screen: 'You have sent{any} 0. Exit', reply: { keys: '0' } }),
      ),
    ).toContain(
      'step 5 sends the money (the PIN is typed and the confirmation shown), so it must be the last step',
    );
    const bank = structuredClone<PayoutMenuScript>(BANK);
    steps(bank).push({ screen: 'Add a remark', reply: { keys: '0' } });
    expect(validatePayoutMenuScript(bank).join(' ')).toMatch(/step 5 sends the money/);
  });

  it('refuses templates that would match anything, unknown placeholders and bad keys', () => {
    expect(problems((s) => (steps(s)[1]!.screen = '{any}'))).toContain(
      'step 2: the screen template needs some fixed text',
    );
    expect(problems((s) => (steps(s)[1]!.screen = 'Enter {phone}'))).toContain(
      'step 2: the screen template is not valid',
    );
    expect(problems((s) => (steps(s)[1]!.screen = 'Enter {number'))).toContain(
      'step 2: the screen template is not valid',
    );
    expect(problems((s) => (s.success = '{any}{reference}{any}'))).toContain(
      'the success screen template needs some fixed text',
    );
    expect(problems((s) => (steps(s)[0]!.reply = { keys: '1a' }))).toContain(
      'step 1: keys must be 1 to 20 of 0-9 * #',
    );
    expect(problems((s) => (s.dial = '127'))).toContain('dial must look like *127#');
    expect(problems((s) => (steps(s)[3]!.screen += ' {reference}'))).toContain(
      'step 4: {reference} belongs to the success screen only',
    );
    expect(
      problems((s) => ((s.failures as { screen: string; code: string }[])[0]!.code = 'Wrong PIN')),
    ).toContain('failure 1: code must be lower-case letters, digits and _');
  });

  it('never throws, whatever it is given', () => {
    for (const junk of [null, undefined, 7, 'x', [], { steps: 'no' }, { steps: [null, 3] }]) {
      expect(validatePayoutMenuScript(junk as unknown as PayoutMenuScript).length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('nextPayoutMenuAction: the path of a transfer', () => {
  it('dials, types the choice, the number, the amount, confirms, asks for the PIN last, and reads the reference', () => {
    const actions: PayoutMenuAction[] = [];
    for (let shown = 0; shown <= SCREENS.length; shown += 1) {
      actions.push(walk(SCREENS.slice(0, shown)));
    }
    expect(actions).toEqual([
      { kind: 'dial', code: '*127#' },
      { kind: 'reply', step: 0, text: '1', commit: false },
      { kind: 'reply', step: 1, text: '0911234567', commit: false },
      { kind: 'reply', step: 2, text: '1500', commit: false },
      { kind: 'reply', step: 3, text: '1', commit: false },
      { kind: 'reply_pin', step: 4, commit: true },
      { kind: 'finish', outcome: 'sent', reference: 'CK48XR21PQ' },
    ]);
  });

  it('follows a PIN-first menu: the PIN is not the commit, the last confirmation is', () => {
    const transfer = { ...TRANSFER, amount: 150_050n };
    const screens = [
      'Enter your PIN',
      'Main menu 1. Balance 3. Transfer 9. Exit',
      'Receiver number',
      'Amount',
      'Transfer ETB 1500.50 to 251911234567. 1. OK 0. Back',
      'Done. Ref FT24XYZ001',
    ];
    expect(nextPayoutMenuAction(BANK, transfer, screens.slice(0, 1))).toEqual({
      kind: 'reply_pin',
      step: 0,
      commit: false,
    });
    expect(nextPayoutMenuAction(BANK, transfer, screens.slice(0, 3))).toEqual({
      kind: 'reply',
      step: 2,
      text: '251911234567',
      commit: false,
    });
    expect(nextPayoutMenuAction(BANK, transfer, screens.slice(0, 4))).toEqual({
      kind: 'reply',
      step: 3,
      text: '1500.50',
      commit: false,
    });
    expect(nextPayoutMenuAction(BANK, transfer, screens.slice(0, 5))).toEqual({
      kind: 'reply',
      step: 4,
      text: '1',
      commit: true,
    });
    expect(nextPayoutMenuAction(BANK, transfer, screens)).toEqual({
      kind: 'finish',
      outcome: 'sent',
      reference: 'FT24XYZ001',
    });
  });

  it('refuses before dialling what it could not type: a bad number, no amount, santim in a whole-birr menu', () => {
    const notSent = (reason: string) => ({ kind: 'finish', outcome: 'not_sent', reason });
    expect(walk([], { ...TRANSFER, number: '0911234567' })).toEqual(notSent('invalid_transfer'));
    expect(walk([], { ...TRANSFER, number: '+251811234567' })).toEqual(notSent('invalid_transfer'));
    expect(walk([], { ...TRANSFER, amount: 0n })).toEqual(notSent('invalid_transfer'));
    expect(walk([], { ...TRANSFER, amount: 1500 as unknown as bigint })).toEqual(
      notSent('invalid_transfer'),
    );
    expect(walk([], { ...TRANSFER, amount: 150_050n })).toEqual(notSent('amount_not_whole_birr'));
    expect(walk([], TRANSFER, { ...WALLET, dial: 'x' })).toEqual(notSent('invalid_script'));
  });
});

describe('nextPayoutMenuAction: stopping', () => {
  const withScreen = (index: number, text: unknown) =>
    SCREENS.slice(0, index + 1).map((screen, i) => (i === index ? text : screen));
  const notSent = (reason: string) => ({ kind: 'finish', outcome: 'not_sent', reason });
  const unknown = (reason: string) => ({ kind: 'finish', outcome: 'unknown', reason });

  it('stops, with nothing sent, at any screen before the commit that is not the expected one', () => {
    for (let index = 0; index < WALLET.steps.length; index += 1) {
      for (const other of ['Service unavailable', '', null, 42, 'Enter PIN again']) {
        expect(walk(withScreen(index, other)), `step ${index}: ${String(other)}`).toEqual(
          notSent('unexpected_screen'),
        );
      }
    }
  });

  it('stops when the confirmation shows another number, another amount or another name', () => {
    const confirm = (text: string) => walk(withScreen(3, text));
    expect(
      confirm('Send 1,500.00 Birr to ABEBE KEBEDE 0911234568? Fee 3.45 Birr. 1. Confirm 2. Cancel'),
    ).toEqual(notSent('number_differs'));
    expect(
      confirm('Send 1,500.01 Birr to ABEBE KEBEDE 0911234567? Fee 3.45 Birr. 1. Confirm 2. Cancel'),
    ).toEqual(notSent('amount_differs'));
    // The menu took the amount ten times over, or read the number as the amount.
    expect(
      confirm(
        'Send 15,000.00 Birr to ABEBE KEBEDE 0911234567? Fee 3.45 Birr. 1. Confirm 2. Cancel',
      ),
    ).toEqual(notSent('amount_differs'));
    expect(
      confirm('Send 1,500.00 Birr to SARA HAILE 0911234567? Fee 3.45 Birr. 1. Confirm 2. Cancel'),
    ).toEqual(notSent('name_differs'));
  });

  it('does not accept a name on the screen when we know none for the player', () => {
    expect(walk(SCREENS.slice(0, 4), { ...TRANSFER, name: null })).toEqual(notSent('name_differs'));
    expect(walk(SCREENS.slice(0, 4), { ...TRANSFER, name: '  ' })).toEqual(notSent('name_differs'));
  });

  it('accepts the first two names of the holder, as a bank SMS would show them', () => {
    expect(walk(SCREENS.slice(0, 4))).toEqual({ kind: 'reply', step: 3, text: '1', commit: false });
  });

  it('after the commit: a known failure is not sent, anything else is unknown, never sent', () => {
    const result = (text: unknown) => walk([...SCREENS.slice(0, 5), text]);
    expect(result('Incorrect PIN. 2 attempts left')).toEqual(notSent('failed_wrong_pin'));
    expect(result('Sorry, insufficient balance')).toEqual(notSent('failed_insufficient_balance'));
    expect(result('Request is being processed')).toEqual(unknown('unexpected_result'));
    expect(result('')).toEqual(unknown('unexpected_result'));
    expect(result(null)).toEqual(unknown('unexpected_result'));
    // A success screen for another amount or another number is not this payout's success.
    expect(
      result('You have sent 150.00 Birr to 0911234567. Transaction CK48XR21PQ. Balance 1 Birr'),
    ).toEqual(unknown('unexpected_result'));
    expect(
      result('You have sent 1500.00 Birr to 0911234568. Transaction CK48XR21PQ. Balance 1 Birr'),
    ).toEqual(unknown('unexpected_result'));
    expect(walk([...SCREENS, 'one screen too many'])).toEqual(unknown('unexpected_result'));
  });

  it('a history that does not fit the script, once the commit was typed, is unknown', () => {
    const screens = [...SCREENS];
    screens[1] = 'something else';
    expect(walk(screens)).toEqual(unknown('unexpected_screen'));
  });

  it('a broken session: nothing sent before the commit was started, unknown from then on', () => {
    for (let started = 0; started < WALLET.steps.length; started += 1) {
      expect(payoutMenuOutcomeAfterBreak(WALLET, started).outcome).toBe('not_sent');
    }
    expect(payoutMenuOutcomeAfterBreak(WALLET, WALLET.steps.length).outcome).toBe('unknown');
    expect(payoutMenuOutcomeAfterBreak(WALLET, 99).outcome).toBe('unknown');
    // A count that makes no sense is treated as the worst case.
    expect(payoutMenuOutcomeAfterBreak(WALLET, -1).outcome).toBe('unknown');
    expect(payoutMenuOutcomeAfterBreak(WALLET, 2.5).outcome).toBe('unknown');
    expect(payoutMenuOutcomeAfterBreak({} as PayoutMenuScript, 0).outcome).toBe('unknown');
  });
});

describe('matchPayoutMenuScreen and parseMenuAmount', () => {
  it('reads amounts exactly, in santim', () => {
    expect(parseMenuAmount('1500')).toBe(150_000n);
    expect(parseMenuAmount('1,500')).toBe(150_000n);
    expect(parseMenuAmount('1,500.5')).toBe(150_050n);
    expect(parseMenuAmount('1500.05')).toBe(150_005n);
    expect(parseMenuAmount('0.99')).toBe(99n);
    for (const bad of ['', '1.500,00', '1,50', '1500.', '1500.555', '-5', '1e3', ' 5']) {
      expect(parseMenuAmount(bad), bad).toBeNull();
    }
  });

  it('never reads an amount or a number out of the middle of a longer one', () => {
    const five = { ...TRANSFER, amount: 500n };
    expect(matchPayoutMenuScreen('send {amount} birr', 'send 5 birr', five)).toEqual({
      ok: true,
      reference: null,
    });
    for (const screen of ['send 1500 birr', 'send 5.50 birr', 'send 5,000 birr', 'send 15 birr']) {
      expect(matchPayoutMenuScreen('send {amount} birr', screen, five).ok, screen).toBe(false);
      expect(matchPayoutMenuScreen('{any}{amount} birr{any}', screen, five).ok, screen).toBe(false);
    }
    // Figures that are not amounts as we know them are not read in part either.
    const loose = '{any}{amount} birr{any}';
    expect(
      matchPayoutMenuScreen(loose, 'send 1.555 birr', { ...TRANSFER, amount: 55_500n }).ok,
    ).toBe(false);
    expect(
      matchPayoutMenuScreen(loose, 'send 12,5000 birr', { ...TRANSFER, amount: 500_000n }).ok,
    ).toBe(false);
    expect(matchPayoutMenuScreen(loose, 'send 5.5.5 birr', five).ok).toBe(false);
    expect(matchPayoutMenuScreen('to {number} ok', 'to 09112345678 ok', TRANSFER).ok).toBe(false);
    expect(matchPayoutMenuScreen('{any}{number}{any}', 'ref 109112345670 sent', TRANSFER).ok).toBe(
      false,
    );
    expect(matchPayoutMenuScreen('to {number} ok', 'to 0911234567 ok', TRANSFER).ok).toBe(true);
    expect(matchPayoutMenuScreen('to {number} ok', 'to +251911234567 ok', TRANSFER).ok).toBe(true);
  });

  it('ignores line breaks, spacing and letter case, and nothing else', () => {
    expect(matchPayoutMenuScreen('Enter  amount', 'ENTER\namount ', TRANSFER).ok).toBe(true);
    expect(matchPayoutMenuScreen('Enter amount', 'Enter amount:', TRANSFER).ok).toBe(false);
    expect(matchPayoutMenuScreen('Enter amount', 'x'.repeat(5000), TRANSFER).ok).toBe(false);
  });
});

// --- Properties ---------------------------------------------------------------------------------

const subscriber = fc.stringMatching(/^[79]\d{8}$/);
const transferArb: fc.Arbitrary<PayoutMenuTransfer> = fc.record({
  number: subscriber.map((s) => `+251${s}`),
  amount: fc.bigInt({ min: 1n, max: 5_000_000n }).map((birr) => birr * 100n),
  name: fc.constantFrom('Abebe Kebede Tesfaye', 'Sara Haile', 'Chaltu Tolosa Bekele'),
});

/** The screens the invented wallet menu would show for a transfer that goes through. */
function honestScreens(transfer: PayoutMenuTransfer): string[] {
  const local = `0${transfer.number.slice(-9)}`;
  const birr = (transfer.amount / 100n).toString();
  return [
    'Welcome to telebirr 1. Send Money 2. Buy Airtime',
    'Enter mobile number',
    'Enter amount',
    `Send ${birr}.00 Birr to ${transfer.name ?? ''} ${local}? Fee 1.15 Birr. 1. Confirm 2. Cancel`,
    'Enter PIN',
    `You have sent ${birr}.00 Birr to ${local}. Transaction AB12CD34EF. Thank you`,
  ];
}

describe('nextPayoutMenuAction: properties', () => {
  it('an honest menu always ends in sent, and the PIN is asked for exactly once, at the commit', () => {
    fc.assert(
      fc.property(transferArb, (transfer) => {
        const screens = honestScreens(transfer);
        let pins = 0;
        let commits = 0;
        for (let shown = 0; shown < screens.length; shown += 1) {
          const action = walk(screens.slice(0, shown), transfer);
          if (action.kind === 'reply_pin') pins += 1;
          if ((action.kind === 'reply' || action.kind === 'reply_pin') && action.commit) {
            commits += 1;
          }
          expect(action.kind).not.toBe('finish');
        }
        expect(pins).toBe(1);
        expect(commits).toBe(1);
        expect(walk(screens, transfer)).toMatchObject({ kind: 'finish', outcome: 'sent' });
      }),
    );
  });

  it('the commit is never reached unless the confirmation showed this number and this amount', () => {
    fc.assert(
      fc.property(
        transferArb,
        transferArb,
        fc.constantFrom('number', 'amount', 'both'),
        (transfer, other, what) => {
          // The menu confirms a different number and/or amount than the payout's.
          const shownAs: PayoutMenuTransfer = {
            number: what === 'amount' ? transfer.number : other.number,
            amount: what === 'number' ? transfer.amount : other.amount,
            name: transfer.name,
          };
          fc.pre(shownAs.number !== transfer.number || shownAs.amount !== transfer.amount);
          const screens = honestScreens(transfer);
          screens[3] = honestScreens(shownAs)[3]!;
          for (let shown = 4; shown <= screens.length; shown += 1) {
            const action = walk(screens.slice(0, shown), transfer);
            expect(action.kind).toBe('finish');
            if (action.kind === 'finish') expect(action.outcome).not.toBe('sent');
          }
          // Up to the confirmation nothing was committed, so the stop there is "not sent".
          expect(walk(screens.slice(0, 4), transfer)).toMatchObject({ outcome: 'not_sent' });
        },
      ),
    );
  });

  it('one wrong screen anywhere never ends in sent; before the commit it ends in not sent', () => {
    fc.assert(
      fc.property(
        transferArb,
        fc.integer({ min: 0, max: 5 }),
        fc.string({ maxLength: 60 }),
        (transfer, at, junk) => {
          const screens = honestScreens(transfer);
          fc.pre(junk.replace(/\s+/g, ' ').trim().toLowerCase() !== screens[at]!.toLowerCase());
          fc.pre(!/incorrect pin|insufficient balance/i.test(junk));
          screens[at] = junk;
          const shownUpTo = walk(screens.slice(0, at + 1), transfer);
          expect(shownUpTo.kind).toBe('finish');
          if (shownUpTo.kind !== 'finish') return;
          expect(shownUpTo.outcome).toBe(at < WALLET.steps.length ? 'not_sent' : 'unknown');
          const all = walk(screens, transfer);
          expect(all).toMatchObject({ kind: 'finish' });
          if (all.kind === 'finish') expect(all.outcome).not.toBe('sent');
        },
      ),
    );
  });

  it('arbitrary screens never throw, never reach the commit and never report sent', () => {
    fc.assert(
      fc.property(
        transferArb,
        fc.array(
          fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.constantFrom(...SCREENS)),
          {
            maxLength: 8,
          },
        ),
        (transfer, screens) => {
          const action = walk(screens, transfer);
          if (action.kind === 'finish') expect(action.outcome).not.toBe('sent');
          if (action.kind === 'reply' || action.kind === 'reply_pin') {
            // The fixed SCREENS confirm another payout's number and amount.
            expect(action.commit).toBe(false);
          }
        },
      ),
    );
  });

  it('is pure: the same input gives the same answer and nothing given is changed', () => {
    fc.assert(
      fc.property(transferArb, fc.integer({ min: 0, max: 6 }), (transfer, shown) => {
        const screens = Object.freeze(honestScreens(transfer).slice(0, shown));
        const script = structuredClone<PayoutMenuScript>(WALLET);
        const before = JSON.stringify(script);
        const first = nextPayoutMenuAction(script, Object.freeze({ ...transfer }), screens);
        const second = nextPayoutMenuAction(script, Object.freeze({ ...transfer }), screens);
        expect(second).toEqual(first);
        expect(JSON.stringify(script)).toBe(before);
      }),
    );
  });
});
