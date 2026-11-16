import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTO_SETTLE_ACTOR,
  DOUBLE_PROOF_CLOCK_SKEW_MS,
  DOUBLE_PROOF_RULE_VERSION,
  DOUBLE_PROOF_WAIT_RETRY,
  decideDoubleProof,
  doubleProofEarliestTransfer,
  type DebitReceiptFacts,
  type DoubleProofInput,
  type MismatchCode,
  type ProofDecision,
  type WaitCode,
} from './payoutproof';

const MIN = 60_000;
const CLAIM = new Date('2026-11-15T07:00:30Z');
const RECEIVED = new Date('2026-11-15T07:10:30Z');
const TRANSFER = new Date('2026-11-15T07:10:00Z'); // receipt: minute precision
const SMS_TIME = new Date('2026-11-15T07:10:05Z');
const FETCHED = new Date('2026-11-15T07:11:00Z');
const NOW = new Date('2026-11-15T07:12:00Z');
const DEST = '+251922334455';
const OURS = '+251911000111';
const REF = 'CKF12ABC34';

/** A claimed telebirr payout whose debit SMS and receipt agree on everything: settles. */
function valid(): DoubleProofInput {
  return {
    payout: {
      id: 'p1',
      manual: true,
      provider: 'sms',
      status: 'processing',
      amount: 50_000n,
      destinationInstitution: 'telebirr',
      destinationAccount: DEST,
      playerCurrentPhone: DEST,
      approvedBy: 'admin-1',
      payingBy: 'op-1',
      claimedAt: CLAIM,
      amlHold: false,
      openReceiptAlarm: false,
      referenceSettledElsewhere: false,
    },
    sms: {
      id: 's1',
      source: 'gateway',
      institution: 'telebirr',
      direction: 'debit',
      amount: 50_000n,
      reference: REF,
      counterpartyPhone: DEST,
      occurredAt: SMS_TIME,
      receivedAt: RECEIVED,
      status: 'settlement_proposed',
      proposedPayoutId: 'p1',
    },
    receipt: {
      status: 'verified',
      reason: null,
      facts: {
        reference: REF,
        principalAmount: 50_000n,
        payerAccount: '251911***111',
        receiverAccount: '251922***455',
        completed: true,
        occurredAt: TRANSFER,
      },
      fetchedAt: FETCHED,
    },
    policy: {
      institutions: ['telebirr'],
      collectionAccounts: [OURS],
      maxPerPayout: 100_000n,
      remainingToday: 2_000_000n,
      remainingTodayForClaimer: 500_000n,
      windowMs: 4 * 60 * MIN,
      maxReceiptAgeMs: 5 * MIN,
      notFoundGraceMs: 15 * MIN,
      minRevealedDestinationDigits: 6,
    },
    now: NOW,
  };
}

type Patch = {
  payout?: Partial<Record<keyof DoubleProofInput['payout'], unknown>>;
  sms?: Partial<Record<keyof DoubleProofInput['sms'], unknown>>;
  receipt?: Record<string, unknown>;
  facts?: Partial<Record<keyof DebitReceiptFacts, unknown>>;
  policy?: Partial<Record<keyof DoubleProofInput['policy'], unknown>>;
  now?: unknown;
};

/** The valid input with some fields replaced (values may be ill-typed on purpose). */
function withPatch(patch: Patch, base: DoubleProofInput = valid()): DoubleProofInput {
  const receipt = { ...(base.receipt as Record<string, unknown>), ...patch.receipt };
  if (patch.facts) receipt.facts = { ...(receipt.facts as object), ...patch.facts };
  return {
    payout: { ...base.payout, ...patch.payout },
    sms: { ...base.sms, ...patch.sms },
    receipt,
    policy: { ...base.policy, ...patch.policy },
    now: 'now' in patch ? patch.now : base.now,
  } as DoubleProofInput;
}

const decide = (patch: Patch) => decideDoubleProof(withPatch(patch));

function waits(...codes: WaitCode[]): ProofDecision {
  return {
    decision: 'wait',
    reasons: codes.map((code) => ({ code, retry: DOUBLE_PROOF_WAIT_RETRY[code] })),
    ruleVersion: DOUBLE_PROOF_RULE_VERSION,
  };
}

function mismatches(...codes: MismatchCode[]): ProofDecision {
  return { decision: 'mismatch', reasons: codes, ruleVersion: DOUBLE_PROOF_RULE_VERSION };
}

const SETTLE: ProofDecision = {
  decision: 'settle',
  ruleVersion: DOUBLE_PROOF_RULE_VERSION,
  settledBy: 'op-1',
};

describe('decideDoubleProof: the decision table', () => {
  it('settles when both proofs agree, recorded under the claimer', () => {
    expect(decideDoubleProof(valid())).toEqual(SETTLE);
    expect(AUTO_SETTLE_ACTOR).toBe('system:double_proof');
  });

  it('E1 waits for a person unless it is a manual SMS-rail payout', () => {
    expect(decide({ payout: { manual: false } })).toEqual(waits('not_manual'));
    expect(decide({ payout: { manual: null } })).toEqual(waits('not_manual'));
    expect(decide({ payout: { provider: 'chapa' } })).toEqual(waits('not_manual'));
    expect(decide({ payout: { provider: null } })).toEqual(waits('not_manual'));
    expect(waits('not_manual')).toMatchObject({ reasons: [{ retry: false }] });
  });

  it('E2 waits unless the institution is allowlisted and a wallet', () => {
    expect(decide({ policy: { institutions: [] } })).toEqual(waits('institution_not_allowed'));
    expect(decide({ policy: { institutions: ['mpesa'] } })).toEqual(
      waits('institution_not_allowed'),
    );
    expect(decide({ policy: { institutions: null } })).toEqual(waits('institution_not_allowed'));
    // A bank, even allowlisted and with an SMS of the same bank, is never a candidate.
    expect(
      decide({
        payout: { destinationInstitution: 'cbe' },
        sms: { institution: 'cbe' },
        policy: { institutions: ['telebirr', 'cbe'] },
      }),
    ).toEqual(waits('institution_not_allowed'));
  });

  it('E3 waits above the per-payout cap (and for a non-positive amount)', () => {
    expect(decide({ policy: { maxPerPayout: 50_000n } })).toEqual(SETTLE);
    expect(decide({ policy: { maxPerPayout: 49_999n } })).toEqual(waits('over_payout_cap'));
    expect(decide({ policy: { maxPerPayout: null } })).toEqual(waits('over_payout_cap'));
    expect(decide({ policy: { maxPerPayout: 100_000 } })).toEqual(waits('over_payout_cap'));
    expect(
      decide({
        payout: { amount: 0n },
        sms: { amount: 0n },
        facts: { principalAmount: 0n },
      }),
    ).toEqual(waits('over_payout_cap'));
  });

  it('E4 waits above either daily cap', () => {
    expect(
      decide({ policy: { remainingToday: 50_000n, remainingTodayForClaimer: 50_000n } }),
    ).toEqual(SETTLE);
    expect(decide({ policy: { remainingToday: 49_999n } })).toEqual(waits('over_daily_cap'));
    expect(decide({ policy: { remainingTodayForClaimer: 49_999n } })).toEqual(
      waits('over_daily_cap'),
    );
    expect(decide({ policy: { remainingToday: -1n } })).toEqual(waits('over_daily_cap'));
    expect(decide({ policy: { remainingTodayForClaimer: null } })).toEqual(waits('over_daily_cap'));
  });

  it('E5 waits while the player is on hold', () => {
    expect(decide({ payout: { amlHold: true } })).toEqual(waits('player_on_hold'));
    expect(decide({ payout: { openReceiptAlarm: true } })).toEqual(waits('player_on_hold'));
    expect(decide({ payout: { amlHold: null } })).toEqual(waits('player_on_hold'));
    expect(decide({ payout: { openReceiptAlarm: undefined } })).toEqual(waits('player_on_hold'));
  });

  it("E6 waits unless the destination is the player's current phone, in E.164", () => {
    expect(decide({ payout: { playerCurrentPhone: '+251922334456' } })).toEqual(
      waits('destination_not_current_phone'),
    );
    expect(decide({ payout: { playerCurrentPhone: null } })).toEqual(
      waits('destination_not_current_phone'),
    );
    // The same number everywhere, but not canonical: only E6 refuses it.
    expect(
      decide({
        payout: { destinationAccount: '0922334455', playerCurrentPhone: '0922334455' },
        sms: { counterpartyPhone: '0922334455' },
      }),
    ).toEqual(waits('destination_not_current_phone'));
  });

  it('S1 stops checking a payout that is not claimed', () => {
    expect(decide({ payout: { status: 'approved' } })).toEqual(waits('not_processing'));
    expect(decide({ payout: { status: 'paid' } })).toEqual(waits('not_processing'));
    expect(decide({ payout: { payingBy: null } })).toEqual(waits('not_processing'));
    expect(decide({ payout: { claimedAt: null } })).toEqual(waits('not_processing'));
    expect(decide({ payout: { claimedAt: new Date(Number.NaN) } })).toEqual(
      waits('not_processing'),
    );
  });

  it('S2 is a mismatch when the claimer approved it, is not a person, or nobody approved it', () => {
    expect(decide({ payout: { payingBy: 'admin-1' } })).toEqual(mismatches('four_eyes_violation'));
    expect(decide({ payout: { approvedBy: null } })).toEqual(mismatches('four_eyes_violation'));
    expect(decide({ payout: { payingBy: 'system:auto', approvedBy: 'admin-1' } })).toEqual(
      mismatches('four_eyes_violation'),
    );
    expect(decide({ payout: { payingBy: AUTO_SETTLE_ACTOR } })).toEqual(
      mismatches('four_eyes_violation'),
    );
    // An auto-approved payout claimed by a person settles.
    expect(decide({ payout: { approvedBy: 'system:auto' } })).toEqual(SETTLE);
  });

  it('S3 stops unless the SMS is the live proposal for this payout', () => {
    expect(decide({ sms: { status: 'settled' } })).toEqual(waits('sms_not_proposed'));
    expect(decide({ sms: { status: 'ignored_debit' } })).toEqual(waits('sms_not_proposed'));
    expect(decide({ sms: { proposedPayoutId: 'p2' } })).toEqual(waits('sms_not_proposed'));
    expect(decide({ sms: { proposedPayoutId: null } })).toEqual(waits('sms_not_proposed'));
    expect(decide({ sms: { id: '' } })).toEqual(waits('sms_not_proposed'));
  });

  it('P1 waits for a person unless the SMS came from the handset', () => {
    expect(decide({ sms: { source: 'simulator' } })).toEqual(waits('sms_not_from_gateway'));
    expect(decide({ sms: { source: 'receipt' } })).toEqual(waits('sms_not_from_gateway'));
    expect(decide({ sms: { source: null } })).toEqual(waits('sms_not_from_gateway'));
  });

  it('P2 is a mismatch unless the SMS is a debit of the same institution', () => {
    expect(decide({ sms: { direction: 'credit' } })).toEqual(mismatches('sms_not_debit'));
    expect(decide({ sms: { direction: null } })).toEqual(mismatches('sms_not_debit'));
    expect(decide({ sms: { institution: 'mpesa' } })).toEqual(
      mismatches('sms_institution_differs'),
    );
    expect(decide({ sms: { institution: null } })).toEqual(mismatches('sms_institution_differs'));
  });

  it('P3 waits for a person when the SMS does not name the destination (amount-only proposal)', () => {
    expect(decide({ sms: { counterpartyPhone: null } })).toEqual(waits('sms_without_destination'));
    expect(decide({ sms: { counterpartyPhone: '' } })).toEqual(waits('sms_without_destination'));
  });

  it('P4 is a mismatch when the SMS names another number', () => {
    expect(decide({ sms: { counterpartyPhone: '+251922334456' } })).toEqual(
      mismatches('sms_destination_differs'),
    );
  });

  it('P5 is a mismatch unless the SMS amount is exact to the santim', () => {
    expect(decide({ sms: { amount: 49_999n } })).toEqual(mismatches('sms_amount_differs'));
    expect(decide({ sms: { amount: 50_001n } })).toEqual(mismatches('sms_amount_differs'));
    expect(decide({ sms: { amount: null } })).toEqual(mismatches('sms_amount_differs'));
    expect(decide({ sms: { amount: 50_000 } })).toEqual(mismatches('sms_amount_differs'));
  });

  it('P6 waits for a person when the SMS arrived before this claim', () => {
    const reclaimed = new Date(RECEIVED.getTime() + 1);
    expect(decide({ payout: { claimedAt: reclaimed } })).toEqual(waits('sms_before_claim'));
    expect(decide({ payout: { claimedAt: RECEIVED } })).toEqual(waits('sms_before_claim'));
    expect(decide({ sms: { receivedAt: null } })).toEqual(waits('sms_before_claim'));
  });

  it('P7 waits for a person outside the window', () => {
    const elapsed = RECEIVED.getTime() - CLAIM.getTime();
    expect(decide({ policy: { windowMs: elapsed } })).toEqual(SETTLE);
    expect(decide({ policy: { windowMs: elapsed - 1 } })).toEqual(waits('outside_window'));
    expect(decide({ policy: { windowMs: null } })).toEqual(waits('outside_window'));
    expect(decide({ policy: { windowMs: Number.NaN } })).toEqual(waits('outside_window'));
  });

  it('R1 waits on an indeterminate or unsupported receipt', () => {
    for (const reason of ['unparseable', 'unavailable', 'timeout', 'breaker_open']) {
      const decision = decide({ receipt: { status: 'indeterminate', reason, facts: undefined } });
      expect(decision).toEqual(waits('receipt_indeterminate'));
      expect(decision).toMatchObject({ reasons: [{ retry: true }] });
    }
    expect(decide({ receipt: { status: 'skipped', facts: undefined } })).toEqual(
      waits('receipt_unsupported'),
    );
    expect(decide({ receipt: { status: 'surprise' } })).toEqual(waits('receipt_indeterminate'));
    expect(decide({ receipt: { status: null } })).toEqual(waits('receipt_indeterminate'));
  });

  it('R1 waits for a missing receipt during the grace, then calls it a mismatch', () => {
    const notFound = { status: 'not_found', facts: undefined, reason: undefined };
    expect(decide({ receipt: notFound })).toEqual(waits('receipt_not_found_yet'));
    const afterGrace = new Date(RECEIVED.getTime() + 15 * MIN);
    expect(decide({ receipt: { ...notFound, fetchedAt: afterGrace }, now: afterGrace })).toEqual(
      mismatches('receipt_not_found'),
    );
    const justBefore = new Date(afterGrace.getTime() - 1);
    expect(decide({ receipt: { ...notFound, fetchedAt: justBefore }, now: justBefore })).toEqual(
      waits('receipt_not_found_yet'),
    );
  });

  it('R1 is a mismatch for a rejected receipt, named after its reason', () => {
    expect(decide({ receipt: { status: 'rejected', reason: 'amount_differs' } })).toEqual(
      mismatches('receipt_amount_differs'),
    );
    expect(decide({ receipt: { status: 'rejected', reason: 'payer_not_ours' } })).toEqual(
      mismatches('receipt_payer_not_ours'),
    );
    expect(decide({ receipt: { status: 'rejected', reason: null } })).toEqual(
      mismatches('receipt_rejected'),
    );
    expect(decide({ receipt: { status: 'rejected', reason: 'Not <b>ok</b>' } })).toEqual(
      mismatches('receipt_rejected'),
    );
  });

  it('R2 waits for a fresher receipt', () => {
    const oldest = new Date(NOW.getTime() - 5 * MIN);
    expect(decide({ receipt: { fetchedAt: oldest } })).toEqual(SETTLE);
    expect(decide({ receipt: { fetchedAt: new Date(oldest.getTime() - 1) } })).toEqual(
      waits('receipt_stale'),
    );
    expect(decide({ receipt: { fetchedAt: null } })).toEqual(waits('receipt_stale'));
    expect(decide({ now: null })).toEqual(waits('receipt_stale'));
    expect(decide({ policy: { maxReceiptAgeMs: null } })).toEqual(waits('receipt_stale'));
    // Fetched "after now" is a clock or caller error, not a fresh receipt.
    expect(decide({ receipt: { fetchedAt: NOW } })).toEqual(SETTLE);
    expect(decide({ receipt: { fetchedAt: new Date(NOW.getTime() + 1) } })).toEqual(
      waits('receipt_stale'),
    );
  });

  it('R3 needs the receipt to say completed', () => {
    expect(decide({ facts: { completed: false } })).toEqual(mismatches('receipt_not_completed'));
    expect(decide({ facts: { completed: null } })).toEqual(waits('receipt_status_unreadable'));
    expect(decide({ facts: { completed: 'true' } })).toEqual(waits('receipt_status_unreadable'));
  });

  it('R4 needs the same reference on both proofs', () => {
    expect(decide({ facts: { reference: null } })).toEqual(waits('receipt_reference_unreadable'));
    expect(decide({ facts: { reference: '  ' } })).toEqual(waits('receipt_reference_unreadable'));
    expect(decide({ facts: { reference: 'CKF12ABC35' } })).toEqual(mismatches('reference_differs'));
    expect(decide({ sms: { reference: 'CKF12ABC35' } })).toEqual(mismatches('reference_differs'));
    expect(decide({ facts: { reference: 'ckf12abc34' } })).toEqual(mismatches('reference_differs'));
    expect(decide({ sms: { reference: null } })).toEqual(mismatches('reference_differs'));
  });

  it('R5 needs the labelled principal, exact to the santim', () => {
    expect(decide({ facts: { principalAmount: null } })).toEqual(
      waits('receipt_amount_unreadable'),
    );
    expect(decide({ facts: { principalAmount: 50_001n } })).toEqual(
      mismatches('receipt_amount_differs'),
    );
    expect(decide({ facts: { principalAmount: 49_999n } })).toEqual(
      mismatches('receipt_amount_differs'),
    );
    // A number (a float in the making) is not an amount.
    expect(decide({ facts: { principalAmount: 50_000 } })).toEqual(
      waits('receipt_amount_unreadable'),
    );
  });

  it('R6 needs our collection account as the payer', () => {
    expect(decide({ facts: { payerAccount: null } })).toEqual(waits('payer_unreadable'));
    expect(decide({ facts: { payerAccount: '251*********' } })).toEqual(waits('payer_unreadable'));
    // Only three subscriber digits shown: any number ending in 111 would do.
    expect(decide({ facts: { payerAccount: '251******111' } })).toEqual(waits('payer_unreadable'));
    expect(decide({ facts: { payerAccount: '251911***112' } })).toEqual(
      mismatches('payer_not_ours'),
    );
    expect(decide({ facts: { payerAccount: '+251911000111' } })).toEqual(SETTLE);
    expect(decide({ policy: { collectionAccounts: [] } })).toEqual(mismatches('payer_not_ours'));
    expect(decide({ policy: { collectionAccounts: ['+251911000999', OURS] } })).toEqual(SETTLE);
  });

  it("R7 needs the payout's destination as the receiver, with enough digits shown", () => {
    expect(decide({ facts: { receiverAccount: null } })).toEqual(waits('receiver_unreadable'));
    // Only 4 subscriber digits shown (the 251 prefix reveals nothing).
    expect(decide({ facts: { receiverAccount: '2519*****455' } })).toEqual(
      waits('receiver_unreadable'),
    );
    // The tail hidden.
    expect(decide({ facts: { receiverAccount: '2519223344**' } })).toEqual(
      waits('receiver_unreadable'),
    );
    expect(decide({ facts: { receiverAccount: '251922***456' } })).toEqual(
      mismatches('receiver_differs'),
    );
    expect(decide({ facts: { receiverAccount: '0922334455' } })).toEqual(SETTLE);
    expect(decide({ policy: { minRevealedDestinationDigits: 7 } })).toEqual(
      waits('receiver_unreadable'),
    );
    expect(decide({ policy: { minRevealedDestinationDigits: null } })).toEqual(
      waits('receiver_unreadable'),
    );
  });

  it('T1 needs the transfer after the claim (minute floor less the clock skew)', () => {
    const earliest = doubleProofEarliestTransfer(CLAIM)!;
    expect(earliest.toISOString()).toBe('2026-11-15T06:55:00.000Z');
    expect(decide({ sms: { occurredAt: null }, facts: { occurredAt: earliest } })).toEqual(SETTLE);
    expect(
      decide({
        sms: { occurredAt: null },
        facts: { occurredAt: new Date(earliest.getTime() - MIN) },
      }),
    ).toEqual(mismatches('transfer_before_claim'));
    expect(decide({ facts: { occurredAt: null } })).toEqual(waits('receipt_time_unreadable'));
    expect(decide({ facts: { occurredAt: new Date(Number.NaN) } })).toEqual(
      waits('receipt_time_unreadable'),
    );
  });

  it('T2 is a mismatch when the SMS arrived before the transfer happened', () => {
    expect(DOUBLE_PROOF_CLOCK_SKEW_MS).toBe(5 * MIN);
    const latest = new Date(RECEIVED.getTime() + DOUBLE_PROOF_CLOCK_SKEW_MS);
    expect(decide({ sms: { occurredAt: null }, facts: { occurredAt: latest } })).toEqual(SETTLE);
    expect(
      decide({ sms: { occurredAt: null }, facts: { occurredAt: new Date(latest.getTime() + 1) } }),
    ).toEqual(mismatches('sms_precedes_transfer'));
  });

  it('T3 needs the SMS time, when it has one, within two minutes of the receipt', () => {
    expect(decide({ sms: { occurredAt: null } })).toEqual(SETTLE);
    const edge = new Date(TRANSFER.getTime() + 2 * MIN);
    expect(decide({ sms: { occurredAt: edge } })).toEqual(SETTLE);
    expect(decide({ sms: { occurredAt: new Date(edge.getTime() + 1) } })).toEqual(
      mismatches('times_disagree'),
    );
    expect(decide({ sms: { occurredAt: new Date(TRANSFER.getTime() - 2 * MIN - 1) } })).toEqual(
      mismatches('times_disagree'),
    );
    expect(decide({ sms: { occurredAt: undefined } })).toEqual(mismatches('times_disagree'));
  });

  it('U1 is a mismatch when the reference already settled another payout', () => {
    expect(decide({ payout: { referenceSettledElsewhere: true } })).toEqual(
      mismatches('reference_already_used'),
    );
    expect(decide({ payout: { referenceSettledElsewhere: null } })).toEqual(
      mismatches('reference_already_used'),
    );
  });

  it('collects every reason: any mismatch wins over waits', () => {
    expect(
      decide({
        payout: { payingBy: 'admin-1', amlHold: true },
        receipt: { status: 'indeterminate', reason: 'timeout', facts: undefined },
        sms: { amount: 1n },
      }),
    ).toEqual(mismatches('four_eyes_violation', 'sms_amount_differs'));
    expect(
      decide({ payout: { amlHold: true }, policy: { remainingToday: 0n }, now: null }),
    ).toEqual(waits('over_daily_cap', 'player_on_hold', 'receipt_stale'));
  });
});

// --- Properties ---------------------------------------------------------------

const subscriber = fc.stringMatching(/^9\d{8}$/);
const reference = fc.stringMatching(/^[A-Z0-9]{8,14}$/);

/** Arbitrary inputs that must settle: every bound respected with some margin chosen at random. */
const validInput: fc.Arbitrary<DoubleProofInput> = fc
  .record({
    amount: fc.bigInt({ min: 1n, max: 50_000_000n }),
    capSlack: fc.bigInt({ min: 0n, max: 1_000_000n }),
    daySlack: fc.bigInt({ min: 0n, max: 1_000_000n }),
    claimerSlack: fc.bigInt({ min: 0n, max: 1_000_000n }),
    dest: subscriber,
    ours: subscriber,
    reference,
    receiverForm: fc.constantFrom('251', '0', '+251'),
    receiverMasked: fc.integer({ min: 0, max: 3 }),
    claimedAt: fc.date({
      min: new Date('2026-01-01T00:00:00Z'),
      max: new Date('2027-12-31T00:00:00Z'),
      noInvalidDate: true,
    }),
    windowMs: fc.integer({ min: MIN, max: 8 * 60 * MIN }),
    delayFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    transferBefore: fc.integer({ min: 0, max: 3 * MIN }),
    smsJitter: fc.option(fc.integer({ min: 0, max: 59_999 }), { nil: null }),
    maxAge: fc.integer({ min: 0, max: 10 * MIN }),
    ageFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    afterReceived: fc.integer({ min: 0, max: 60 * MIN }),
    approvedBy: fc.constantFrom('admin-1', 'admin-2', 'system:auto'),
    payingBy: fc.constantFrom('op-1', 'op-2', 'op-3'),
    minRevealed: fc.integer({ min: 0, max: 6 }),
  })
  .map((r) => {
    const claim = r.claimedAt.getTime();
    const delay = Math.max(1, Math.floor(r.windowMs * r.delayFraction));
    const received = claim + delay;
    // The transfer happened between the claim and the SMS; the receipt shows the minute.
    const transferExact = received - Math.min(r.transferBefore, delay);
    const transfer = Math.floor(transferExact / MIN) * MIN;
    const now = received + r.afterReceived;
    const fetched = now - Math.floor(r.maxAge * r.ageFraction);
    const destination = `+251${r.dest}`;
    const shown = r.dest.split('');
    for (let i = 3; i < 3 + r.receiverMasked; i++) shown[i] = '*';
    const receiver = `${r.receiverForm}${shown.join('')}`;
    const payer = `251${r.ours.slice(0, 3)}***${r.ours.slice(-3)}`;
    return {
      payout: {
        id: 'p-1',
        manual: true,
        provider: 'sms',
        status: 'processing',
        amount: r.amount,
        destinationInstitution: 'telebirr',
        destinationAccount: destination,
        playerCurrentPhone: destination,
        approvedBy: r.approvedBy,
        payingBy: r.payingBy,
        claimedAt: new Date(claim),
        amlHold: false,
        openReceiptAlarm: false,
        referenceSettledElsewhere: false,
      },
      sms: {
        id: 's-1',
        source: 'gateway',
        institution: 'telebirr',
        direction: 'debit',
        amount: r.amount,
        reference: r.reference,
        counterpartyPhone: destination,
        occurredAt: r.smsJitter === null ? null : new Date(transferExact + r.smsJitter),
        receivedAt: new Date(received),
        status: 'settlement_proposed',
        proposedPayoutId: 'p-1',
      },
      receipt: {
        status: 'verified',
        reason: null,
        facts: {
          reference: r.reference,
          principalAmount: r.amount,
          payerAccount: payer,
          receiverAccount: receiver,
          completed: true,
          occurredAt: new Date(transfer),
        },
        fetchedAt: new Date(fetched),
      },
      policy: {
        institutions: ['telebirr'],
        collectionAccounts: [`+251${r.ours}`],
        maxPerPayout: r.amount + r.capSlack,
        remainingToday: r.amount + r.daySlack,
        remainingTodayForClaimer: r.amount + r.claimerSlack,
        windowMs: r.windowMs,
        maxReceiptAgeMs: r.maxAge,
        notFoundGraceMs: 15 * MIN,
        minRevealedDestinationDigits: r.minRevealed,
      },
      now: new Date(now),
    } satisfies DoubleProofInput;
  });

/** One different digit at position `index` (mod the digits present) of a phone-like string. */
function changeDigit(value: string, index: number, delta: number): string {
  const positions = [...value].flatMap((ch, i) => (/\d/.test(ch) ? [i] : []));
  const at = positions[index % positions.length]!;
  const digit = (Number(value[at]) + delta) % 10;
  return value.slice(0, at) + String(digit) + value.slice(at + 1);
}

function changeChar(value: string, index: number): string {
  const at = index % value.length;
  const ch = value[at] === 'Z' ? 'Y' : value[at] === '9' ? '8' : 'Z';
  return value.slice(0, at) + ch + value.slice(at + 1);
}

const ms = (d: Date | null) => d!.getTime();

/** Exactly one field of a valid input changed so that its own check must fail. */
type Mutation = (input: DoubleProofInput) => Patch;

/** At least one santim; exactly one santim often. */
const delta = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1_000_000n }));
const digitDelta = fc.integer({ min: 1, max: 9 });
const anyIndex = fc.nat({ max: 50 });
const pastMs = fc.integer({ min: 1, max: 24 * 60 * MIN });

const mut = (name: string, mutate: Mutation) => ({ name, mutate });

/** Digit positions (among the digits of `+251XXXXXXXXX`) the payer mask `251XXX***XXX` shows. */
const PAYER_SHOWN = [0, 1, 2, 3, 4, 5, 9, 10, 11];

/** Digits the receiver value shows in the subscriber part (its last nine characters). */
function shownSubscriberDigits(value: string): number {
  return [...value.slice(-9)].filter((ch) => /\d/.test(ch)).length;
}

const mutations: fc.Arbitrary<{ name: string; mutate: Mutation }> = fc.oneof(
  // Amounts, by at least one santim, on the payout, the SMS or the receipt.
  fc
    .tuple(delta, fc.boolean())
    .map(([d, up]) =>
      mut('payout.amount', (i) => ({ payout: { amount: i.payout.amount + (up ? d : -d) } })),
    ),
  fc
    .tuple(delta, fc.boolean())
    .map(([d, up]) =>
      mut('sms.amount', (i) => ({ sms: { amount: i.sms.amount! + (up ? d : -d) } })),
    ),
  fc.tuple(delta, fc.boolean()).map(([d, up]) =>
    mut('receipt.principalAmount', (i) => ({
      facts: { principalAmount: factsOf(i).principalAmount! + (up ? d : -d) },
    })),
  ),
  // The destination, one digit, in each place it appears.
  fc.tuple(anyIndex, digitDelta).map(([at, dd]) =>
    mut('sms.counterpartyPhone digit', (i) => ({
      sms: { counterpartyPhone: changeDigit(i.sms.counterpartyPhone!, at, dd) },
    })),
  ),
  fc.tuple(anyIndex, digitDelta).map(([at, dd]) =>
    mut('receipt.receiverAccount shown digit', (i) => ({
      facts: { receiverAccount: changeDigit(factsOf(i).receiverAccount!, at, dd) },
    })),
  ),
  fc.tuple(anyIndex, digitDelta).map(([at, dd]) =>
    mut('payout.destinationAccount digit', (i) => ({
      payout: { destinationAccount: changeDigit(i.payout.destinationAccount, at, dd) },
    })),
  ),
  fc.tuple(anyIndex, digitDelta).map(([at, dd]) =>
    mut('payout.playerCurrentPhone digit', (i) => ({
      payout: { playerCurrentPhone: changeDigit(i.payout.playerCurrentPhone!, at, dd) },
    })),
  ),
  // The payer: a shown digit on the receipt, or a shown digit of our account.
  fc.tuple(anyIndex, digitDelta).map(([at, dd]) =>
    mut('receipt.payerAccount shown digit', (i) => ({
      facts: { payerAccount: changeDigit(factsOf(i).payerAccount!, at, dd) },
    })),
  ),
  fc.tuple(fc.constantFrom(...PAYER_SHOWN), digitDelta).map(([at, dd]) =>
    mut('policy.collectionAccounts shown digit', (i) => ({
      policy: { collectionAccounts: [changeDigit(i.policy.collectionAccounts[0]!, at, dd)] },
    })),
  ),
  // Receipt status and completion.
  fc
    .constantFrom(
      { status: 'rejected', reason: 'amount_differs' },
      { status: 'rejected', reason: null },
      { status: 'not_found' },
      { status: 'indeterminate', reason: 'timeout' },
      { status: 'indeterminate', reason: 'breaker_open' },
      { status: 'skipped' },
    )
    .map((r) => mut(`receipt.status ${r.status}`, () => ({ receipt: r }))),
  fc
    .constantFrom(false, null)
    .map((c) => mut(`receipt.completed ${String(c)}`, () => ({ facts: { completed: c } }))),
  // Either reference, one character.
  anyIndex.map((at) =>
    mut('sms.reference char', (i) => ({ sms: { reference: changeChar(i.sms.reference!, at) } })),
  ),
  anyIndex.map((at) =>
    mut('receipt.reference char', (i) => ({
      facts: { reference: changeChar(factsOf(i).reference!, at) },
    })),
  ),
  // Each time, moved outside its bound.
  pastMs.map((d) =>
    mut('claim after the SMS', (i) => ({
      payout: { claimedAt: new Date(ms(i.sms.receivedAt) + d - 1) },
    })),
  ),
  pastMs.map((d) =>
    mut('SMS received before the claim', (i) => ({
      sms: { receivedAt: new Date(ms(i.payout.claimedAt) - d + 1) },
    })),
  ),
  pastMs.map((d) =>
    mut('receipt fetched after now', (i) => ({
      receipt: { fetchedAt: new Date(ms(i.now) + d) },
    })),
  ),
  pastMs.map((d) =>
    mut('SMS outside the window', (i) => ({
      sms: { receivedAt: new Date(ms(i.payout.claimedAt) + i.policy.windowMs + d) },
    })),
  ),
  pastMs.map((d) =>
    mut('transfer before the claim', (i) => ({
      facts: { occurredAt: new Date(ms(doubleProofEarliestTransfer(i.payout.claimedAt)) - d) },
    })),
  ),
  pastMs.map((d) =>
    mut('transfer after the SMS', (i) => ({
      facts: { occurredAt: new Date(ms(i.sms.receivedAt) + DOUBLE_PROOF_CLOCK_SKEW_MS + d) },
    })),
  ),
  fc.tuple(pastMs, fc.boolean()).map(([d, later]) =>
    mut('SMS time disagrees', (i) => {
      const at = ms(factsOf(i).occurredAt);
      const off = 2 * MIN + d;
      return { sms: { occurredAt: new Date(later ? at + off : at - off) } };
    }),
  ),
  pastMs.map((d) =>
    mut('receipt stale', (i) => ({
      receipt: { fetchedAt: new Date(ms(i.now) - i.policy.maxReceiptAgeMs - d) },
    })),
  ),
  pastMs.map((d) =>
    mut('now later than the receipt allows', (i) => ({
      now: new Date(ms(receiptOf(i).fetchedAt) + i.policy.maxReceiptAgeMs + d),
    })),
  ),
  // The SMS itself.
  fc
    .constantFrom('simulator', 'receipt', 'manual', '')
    .map((source) => mut(`sms.source ${source}`, () => ({ sms: { source } }))),
  fc
    .constantFrom('credit', null)
    .map((direction) => mut(`sms.direction ${String(direction)}`, () => ({ sms: { direction } }))),
  fc
    .constantFrom('cbe', 'mpesa', 'ebirr', null)
    .map((institution) =>
      mut(`sms.institution ${String(institution)}`, () => ({ sms: { institution } })),
    ),
  fc.constantFrom('cbe', 'mpesa', 'awash').map((institution) =>
    mut(`payout.destinationInstitution ${institution}`, () => ({
      payout: { destinationInstitution: institution },
    })),
  ),
  fc
    .constantFrom('matched', 'settled', 'ignored_debit', 'flagged')
    .map((status) => mut(`sms.status ${status}`, () => ({ sms: { status } }))),
  fc
    .constantFrom('approved', 'paid', 'failed', 'requested', 'rejected')
    .map((status) => mut(`payout.status ${status}`, () => ({ payout: { status } }))),
  fc.constantFrom('p-2', null, '').map((proposedPayoutId) =>
    mut(`sms.proposedPayoutId ${String(proposedPayoutId)}`, () => ({
      sms: { proposedPayoutId },
    })),
  ),
  fc.constantFrom('p-2', '').map((id) => mut(`payout.id ${id}`, () => ({ payout: { id } }))),
  // The claimer: absent, the approver, or not a person.
  fc.constant(mut('payingBy null', () => ({ payout: { payingBy: null } }))),
  fc.constant(mut('payingBy = approvedBy', (i) => ({ payout: { payingBy: i.payout.approvedBy } }))),
  fc.constant(mut('approvedBy = payingBy', (i) => ({ payout: { approvedBy: i.payout.payingBy } }))),
  fc
    .constantFrom('system:auto', AUTO_SETTLE_ACTOR)
    .map((payingBy) => mut(`payingBy ${payingBy}`, () => ({ payout: { payingBy } }))),
  // Each flag.
  fc
    .constantFrom<Patch['payout'][]>(
      { manual: false },
      { amlHold: true },
      { openReceiptAlarm: true },
      { referenceSettledElsewhere: true },
      { provider: 'chapa' },
    )
    .map((payout) => mut(`flag ${Object.keys(payout!)[0]}`, () => ({ payout }))),
  // The caps and the rest of the policy.
  fc
    .tuple(fc.constantFrom('maxPerPayout', 'remainingToday', 'remainingTodayForClaimer'), delta)
    .map(([cap, d]) => mut(`policy.${cap}`, (i) => ({ policy: { [cap]: i.payout.amount - d } }))),
  fc
    .constantFrom([], ['mpesa'], ['cbe'])
    .map((institutions) => mut('policy.institutions', () => ({ policy: { institutions } }))),
  fc.constant(
    mut('policy.windowMs below the delay', (i) => ({
      policy: { windowMs: ms(i.sms.receivedAt) - ms(i.payout.claimedAt) - 1 },
    })),
  ),
  fc.constant(
    mut('policy.maxReceiptAgeMs below the age', (i) => ({
      policy: { maxReceiptAgeMs: ms(i.now) - ms(receiptOf(i).fetchedAt) - 1 },
    })),
  ),
  fc.integer({ min: 1, max: 5 }).map((more) =>
    mut('policy.minRevealedDestinationDigits above what is shown', (i) => ({
      policy: {
        minRevealedDestinationDigits: shownSubscriberDigits(factsOf(i).receiverAccount!) + more,
      },
    })),
  ),
);

function receiptOf(i: DoubleProofInput) {
  return i.receipt as Extract<DoubleProofInput['receipt'], { facts: DebitReceiptFacts }>;
}

function factsOf(i: DoubleProofInput): DebitReceiptFacts {
  return receiptOf(i).facts;
}

/** Every field path of the input, for the null/delete property. */
const FIELD_PATHS: readonly (readonly string[])[] = [
  ...Object.keys(valid().payout).map((k) => ['payout', k]),
  ...Object.keys(valid().sms).map((k) => ['sms', k]),
  ...Object.keys(valid().receipt).map((k) => ['receipt', k]),
  ...Object.keys(factsOf(valid())).map((k) => ['receipt', 'facts', k]),
  ...Object.keys(valid().policy).map((k) => ['policy', k]),
  ['payout'],
  ['sms'],
  ['receipt'],
  ['policy'],
  ['now'],
];

/**
 * Fields whose absence the rule allows on an otherwise valid input: the SMS
 * without its own time (T3 passes on exactly null; deleted, it does not),
 * the verifier's reason on a verified receipt, and the not-found grace,
 * which only a not-found receipt reads (a not-found receipt never settles).
 */
const MAY_BE_NULL = new Set(['sms.occurredAt', 'receipt.reason', 'policy.notFoundGraceMs']);
const MAY_BE_DELETED = new Set(['receipt.reason', 'policy.notFoundGraceMs']);

const REMOVE = Symbol('remove');

/** A deep copy of `input` with the field at `path` set to `value`, or deleted for `REMOVE`. */
function replaceAt(
  input: DoubleProofInput,
  path: readonly string[],
  value: unknown,
): DoubleProofInput {
  const copy = structuredClone(input) as unknown as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const last = path[path.length - 1]!;
  if (value === REMOVE) delete parent[last];
  else parent[last] = value;
  return copy as unknown as DoubleProofInput;
}

function without(input: DoubleProofInput, path: readonly string[], mode: 'null' | 'delete') {
  return replaceAt(input, path, mode === 'null' ? null : REMOVE);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('decideDoubleProof: properties', () => {
  it('a valid input always settles, recorded under the claimer (never the approver or the system)', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const decision = decideDoubleProof(input);
        expect(decision).toEqual({
          decision: 'settle',
          ruleVersion: DOUBLE_PROOF_RULE_VERSION,
          settledBy: input.payout.payingBy,
        });
        if (decision.decision === 'settle') {
          expect(decision.settledBy).not.toBe(input.payout.approvedBy);
          expect(decision.settledBy.startsWith('system:')).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('changing any single field of a valid input never settles', () => {
    fc.assert(
      fc.property(validInput, mutations, (input, { mutate }) => {
        const decision = decideDoubleProof(withPatch(mutate(input), input));
        expect(decision.decision).not.toBe('settle');
      }),
      { numRuns: 3000 },
    );
  });

  it('nulling or deleting any field never settles', () => {
    fc.assert(
      fc.property(
        validInput,
        fc.constantFrom(...FIELD_PATHS),
        fc.constantFrom('null' as const, 'delete' as const),
        (input, path, mode) => {
          const name = path.join('.');
          fc.pre(!(mode === 'null' ? MAY_BE_NULL : MAY_BE_DELETED).has(name));
          expect(decideDoubleProof(without(input, path, mode)).decision).not.toBe('settle');
        },
      ),
      { numRuns: 2000 },
    );
    // And each path once, deterministically, on the fixed example.
    for (const path of FIELD_PATHS) {
      const name = path.join('.');
      for (const mode of ['null', 'delete'] as const) {
        if ((mode === 'null' ? MAY_BE_NULL : MAY_BE_DELETED).has(name)) continue;
        expect(
          decideDoubleProof(without(valid(), path, mode)).decision,
          `${mode} ${name}`,
        ).not.toBe('settle');
      }
    }
  });

  it('any receipt that is not verified never settles', () => {
    const notVerified = fc.oneof(
      fc.record({ status: fc.constant('rejected'), reason: fc.option(fc.string()) }),
      fc.record({ status: fc.constant('not_found') }),
      fc.record({
        status: fc.constant('indeterminate'),
        reason: fc.constantFrom('unparseable', 'unavailable', 'timeout', 'breaker_open'),
      }),
      fc.record({ status: fc.constant('skipped') }),
      fc.record({ status: fc.string().filter((s) => s !== 'verified') }),
    );
    fc.assert(
      fc.property(validInput, notVerified, (input, receipt) => {
        expect(decideDoubleProof(withPatch({ receipt }, input)).decision).not.toBe('settle');
      }),
    );
  });

  it('is total: arbitrary inputs never throw and give a well-formed decision', () => {
    const anyField = fc.oneof(fc.anything(), fc.date(), fc.bigInt());
    fc.assert(
      fc.property(
        fc.record({
          payout: fc.oneof(anyField, fc.dictionary(fc.string(), anyField)),
          sms: fc.oneof(anyField, fc.dictionary(fc.string(), anyField)),
          receipt: fc.oneof(anyField, fc.dictionary(fc.string(), anyField)),
          policy: fc.oneof(anyField, fc.dictionary(fc.string(), anyField)),
          now: anyField,
        }),
        (input) => {
          const decision = decideDoubleProof(input as unknown as DoubleProofInput);
          expect(['wait', 'mismatch']).toContain(decision.decision);
          expect(decision.ruleVersion).toBe(DOUBLE_PROOF_RULE_VERSION);
        },
      ),
    );
    expect(() => decideDoubleProof(undefined as unknown as DoubleProofInput)).not.toThrow();
    expect(() => decideDoubleProof(null as unknown as DoubleProofInput)).not.toThrow();
  });

  it('is total on valid inputs with any one field replaced by an arbitrary value', () => {
    fc.assert(
      fc.property(validInput, fc.constantFrom(...FIELD_PATHS), fc.anything(), (input, path, v) => {
        const copy = replaceAt(input, path, v);
        const decision = decideDoubleProof(copy);
        if (decision.decision === 'settle') {
          expect(decision.settledBy).toBe(copy.payout.payingBy);
          expect(decision.settledBy).not.toBe(copy.payout.approvedBy);
          expect(decision.settledBy.startsWith('system:')).toBe(false);
        }
      }),
    );
  });

  it('is a pure function: the same input gives the same decision and is not mutated', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          validInput,
          fc.tuple(validInput, mutations).map(([i, m]) => withPatch(m.mutate(i), i)),
        ),
        (input) => {
          const before = structuredClone(input);
          const first = decideDoubleProof(input);
          const second = decideDoubleProof(input);
          expect(second).toEqual(first);
          expect(input).toEqual(before);
          // Frozen input: any write would throw in this strict-mode module.
          expect(decideDoubleProof(deepFreeze(structuredClone(input)))).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });
});
