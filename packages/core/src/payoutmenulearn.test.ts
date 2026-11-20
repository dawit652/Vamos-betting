import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextPayoutMenuAction, type PayoutMenuTransfer } from './payoutmenu';
import { deriveMenuScript, type MenuRecording } from './payoutmenulearn';

/**
 * The screens of an INVENTED wallet menu for one transfer (the same shape as
 * in payoutmenu.test.ts): what the owner would see while recording.
 */
function session(input: {
  local: string;
  birr: bigint;
  name: string;
  fee?: string;
  balance?: string;
  reference?: string;
}): string[] {
  const grouped = input.birr.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [
    'Welcome to telebirr\n1. Send Money\n2. Buy Airtime\n3. My Account',
    'Enter mobile number',
    'Enter amount',
    `Send ${grouped}.00 Birr to ${input.name} ${input.local}? Fee ${input.fee ?? '1.15'} Birr.\n1. Confirm\n2. Cancel`,
    'Enter PIN',
    `You have sent ${input.birr}.00 Birr to ${input.local}. Transaction ${input.reference ?? 'CK48XR21PQ'} on 16/11/2026 10:32. Balance ${input.balance ?? '20,113.10'} Birr`,
  ];
}

function recordingOf(screens: string[], over: Partial<MenuRecording> = {}): MenuRecording {
  const typed: MenuRecording['exchanges'][number]['typed'][] = [
    { keys: '1' },
    { value: 'number' },
    { value: 'amount' },
    { keys: '1' },
    { pin: true },
  ];
  return {
    institution: 'telebirr',
    dial: '*127#',
    numberFormat: 'local',
    amountFormat: 'whole_birr',
    exchanges: typed.map((reply, i) => ({ screen: screens[i]!, typed: reply })),
    result: screens[5]!,
    number: '+251911234567',
    amount: 1_500n, // ETB 15
    shownName: 'ABEBE KEBEDE',
    ...over,
  };
}

const RECORDED = recordingOf(session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' }));

/** Walks a whole session with the script; the final action. */
function walk(
  script: Parameters<typeof nextPayoutMenuAction>[0],
  transfer: PayoutMenuTransfer,
  screens: string[],
) {
  for (let shown = 0; shown < screens.length; shown += 1) {
    const action = nextPayoutMenuAction(script, transfer, screens.slice(0, shown));
    if (action.kind === 'finish') return action;
  }
  return nextPayoutMenuAction(script, transfer, screens);
}

describe('deriveMenuScript', () => {
  it('turns one recorded transfer into a script with the values, the name and the figures taken out', () => {
    const derived = deriveMenuScript(RECORDED);
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    expect(derived.script).toEqual({
      institution: 'telebirr',
      version: 1,
      dial: '*127#',
      numberFormat: 'local',
      amountFormat: 'whole_birr',
      steps: [
        {
          screen: 'Welcome to telebirr 1. Send Money 2. Buy Airtime 3. My Account',
          reply: { keys: '1' },
        },
        { screen: 'Enter mobile number', reply: { value: 'number' } },
        { screen: 'Enter amount', reply: { value: 'amount' } },
        {
          screen: 'Send {amount} Birr to {name} {number}? Fee {any} Birr. 1. Confirm 2. Cancel',
          reply: { keys: '1' },
        },
        { screen: 'Enter PIN', reply: { pin: true } },
      ],
      success:
        'You have sent {amount} Birr to {number}. Transaction {reference} on {any}. Balance {any} Birr',
      failures: [],
    });
    expect(derived.notes).toContain(
      'no failure screens are known: a transfer the menu refuses after the commit is reported as unknown',
    );
  });

  it('gives a script that sends other amounts to other people, with other fees, balances and dates', () => {
    const derived = deriveMenuScript(RECORDED);
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    fc.assert(
      fc.property(
        fc.stringMatching(/^[79]\d{8}$/),
        fc.bigInt({ min: 1n, max: 900_000n }),
        fc.constantFrom('SARA HAILE', 'CHALTU TOLOSA BEKELE', 'ABEBE KEBEDE'),
        fc.bigInt({ min: 0n, max: 99_999n }),
        (subscriber, birr, name, cents) => {
          const screens = session({
            local: `0${subscriber}`,
            birr,
            name,
            fee: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`,
            balance: `${cents},${(cents % 1000n).toString().padStart(3, '0')}.07`,
            reference: `TX${cents}Q7`.padEnd(8, 'Z'),
          });
          const transfer = { number: `+251${subscriber}`, amount: birr * 100n, name };
          expect(walk(derived.script, transfer, screens)).toMatchObject({
            kind: 'finish',
            outcome: 'sent',
          });
          // And it still stops when the menu confirms another amount.
          const other = [...screens];
          other[3] = session({ local: `0${subscriber}`, birr: birr + 1n, name })[3]!;
          expect(walk(derived.script, transfer, other)).toMatchObject({
            kind: 'finish',
            outcome: 'not_sent',
            reason: 'amount_differs',
          });
        },
      ),
    );
  });

  it('keeps the numbers of menu choices as words of the menu: a renumbered menu does not match', () => {
    const derived = deriveMenuScript(RECORDED);
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    const screens = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    screens[0] = 'Welcome to telebirr\n0. Send Money\n1. Buy Airtime\n2. My Account';
    expect(
      walk(
        derived.script,
        { number: '+251911234567', amount: 1_500n, name: 'Abebe Kebede' },
        screens,
      ),
    ).toMatchObject({ outcome: 'not_sent', reason: 'unexpected_screen' });
  });

  it('does not take a figure for the amount or the number on a screen shown before they were typed', () => {
    const screens = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    // By chance the welcome screen shows the same figures as the transfer being recorded.
    screens[0] = 'Welcome. Send from 15 Birr. Help: 0911234567\n1. Send Money\n2. Buy Airtime';
    const derived = deriveMenuScript(recordingOf(screens));
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    expect(derived.script.steps[0]!.screen).toBe(
      'Welcome. Send from {any} Birr. Help: {any} 1. Send Money 2. Buy Airtime',
    );
    // So the script still fits a transfer of another amount to another number.
    const other = session({ local: '0922334455', birr: 40n, name: 'SARA HAILE' });
    other[0] = screens[0]!;
    expect(
      walk(derived.script, { number: '+251922334455', amount: 4_000n, name: 'Sara Haile' }, other),
    ).toMatchObject({ kind: 'finish', outcome: 'sent' });
  });

  it('reads an amount written against its currency', () => {
    const screens = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    screens[3] = 'Send ETB15.00 to ABEBE KEBEDE 0911234567? 1. Confirm 2. Cancel';
    screens[5] = 'Sent 15.00ETB to 0911234567. Ref CK48XR21PQ';
    const derived = deriveMenuScript(recordingOf(screens));
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    expect(derived.script.steps[3]!.screen).toBe(
      'Send ETB{amount} to {name} {number}? 1. Confirm 2. Cancel',
    );
    expect(derived.script.success).toBe('Sent {amount}ETB to {number}. Ref {reference}');
  });

  it('says what the script will not check', () => {
    const noName = deriveMenuScript({ ...RECORDED, shownName: null });
    if (!noName.ok) throw new Error(noName.problems.join('; '));
    // Without the name, the holder's name stays in the template as fixed words: only this
    // person could ever be paid, which the rehearsal with another number shows at once.
    expect(noName.script.steps[3]!.screen).toContain('ABEBE KEBEDE');
    expect(noName.notes.join(' ')).toMatch(/no name was given/);

    const wrongName = deriveMenuScript({ ...RECORDED, shownName: 'SOMEONE ELSE' });
    if (!wrongName.ok) throw new Error(wrongName.problems.join('; '));
    expect(wrongName.notes.join(' ')).toMatch(/the name given was on no screen/);

    const screens = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    screens[5] = 'You have sent 15.00 Birr to 0911234567. Thank you';
    const noReference = deriveMenuScript(recordingOf(screens));
    if (!noReference.ok) throw new Error(noReference.problems.join('; '));
    expect(noReference.notes.join(' ')).toMatch(/no transaction id/);
  });

  it('refuses a recording it cannot make a safe script from, and says why', () => {
    const problems = (recording: MenuRecording) => {
      const derived = deriveMenuScript(recording);
      return derived.ok ? [] : derived.problems;
    };
    // An amount that looks like a menu choice.
    expect(problems({ ...RECORDED, amount: 100n }).join(' ')).toMatch(/at least 11 birr/);
    // No confirmation that shows the values back.
    const blind = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    blind[3] = 'Are you sure?\n1. Confirm\n2. Cancel';
    expect(problems(recordingOf(blind)).join(' ')).toMatch(
      /shows both \{number\} and \{amount\} back/,
    );
    // The recording was of another number than the one given.
    expect(problems({ ...RECORDED, number: '+251922000111' }).join(' ')).toMatch(
      /shows both \{number\} and \{amount\} back/,
    );
    expect(problems({ ...RECORDED, number: '0911234567' }).join(' ')).toMatch(/E\.164/);
    expect(problems({ ...RECORDED, exchanges: [] }).join(' ')).toMatch(/no answered screen/);
    expect(problems({ ...RECORDED, result: ' ' }).join(' ')).toMatch(/result screen is missing/);
    // The amount is also the number of a choice on a later screen.
    const clash = session({ local: '0911234567', birr: 12n, name: 'ABEBE KEBEDE' });
    clash[4] = 'Enter PIN\n12. Help';
    expect(problems(recordingOf(clash, { amount: 1_200n })).join(' ')).toMatch(
      /also the number of a menu choice/,
    );
  });

  it('takes braces and stray marks on a screen as something that changes, never as a placeholder', () => {
    const screens = session({ local: '0911234567', birr: 15n, name: 'ABEBE KEBEDE' });
    screens[1] = 'Enter mobile number {number} \uE001';
    const derived = deriveMenuScript(recordingOf(screens));
    if (!derived.ok) throw new Error(derived.problems.join('; '));
    expect(derived.script.steps[1]!.screen).toBe('Enter mobile number {any}number{any}');
  });

  it('never throws', () => {
    for (const junk of [null, undefined, 3, {}, { exchanges: 'x' }, { exchanges: [null] }]) {
      expect(deriveMenuScript(junk as unknown as MenuRecording).ok).toBe(false);
    }
  });
});
