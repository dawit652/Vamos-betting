import { parseBirr, type Santim } from './money';
import { normalizeEthiopianMsisdn } from './phone';

/**
 * Confirmation SMS from Ethiopian banks and wallets (SMS deposit rail, pure
 * part). Ported from Melabingo's `packages/payments/src/parsers`.
 *
 * The collection SIM receives one of these for every transfer into (credit)
 * or out of (debit) a collection account; a forwarder app on that handset
 * posts it to the api. Parsing never touches the network or the database, so
 * every awkward real-world message can be pinned in a test (see
 * `smsparse.fixtures.ts`).
 *
 * Only the institutions where Vamos holds a collection account send us SMS:
 * inter-bank transfers route through EthSwitch, so a player at any bank can
 * pay into the CBE account and the message comes from CBE. The registry still
 * lists every institution so a new collection account, and payout
 * destinations, are a config entry rather than a new parser.
 *
 * Direction is the safety-critical field: a "you have transferred" message is
 * money leaving the collection account, and crediting it would let anyone
 * fund a wallet by sending money to themselves. A message whose direction is
 * absent or contradictory does not parse.
 */

export type SmsDirection = 'credit' | 'debit';

export type InstitutionKind = 'wallet' | 'bank';

export interface ParsedSms {
  /** Institution id from the registry, e.g. `telebirr`, `cbe`, `awash`. */
  institution: string;
  direction: SmsDirection;
  /** Santim, > 0. */
  amount: Santim;
  /** The institution's transaction reference (uppercase): the dedup and reconciliation key. */
  reference: string;
  counterpartyName: string | null;
  /**
   * E.164, when the message carries one. Wallet-to-wallet transfers usually
   * do; inter-bank transfers usually carry only a name. For a credit it may be
   * masked as the institution printed it ("+2519****3670", telebirr's Amharic
   * credit): compare it only with smsPhoneFits, never with `===`.
   */
  counterpartyPhone: string | null;
  /** The collection account's balance after this transaction, as the institution reports it. */
  balance: Santim | null;
  /** When the institution says it happened (EAT read as UTC+3), or null. */
  occurredAt: Date | null;
}

export interface InstitutionSpec {
  id: string;
  name: string;
  kind: InstitutionKind;
  /**
   * SMS sender addresses / shortcodes. Best-known values: a miss only costs a
   * parse against every spec, never a lost payment.
   */
  senders: readonly string[];
  /** Credit markers beyond the shared ones. */
  creditMarkers?: readonly RegExp[];
  /** Debit markers beyond the shared ones. */
  debitMarkers?: readonly RegExp[];
  /** Reference patterns tried before the shared ones (capture group 1). */
  referencePatterns?: readonly RegExp[];
  /** A receipt link the institution puts in its SMS (group 2: the reference). */
  receiptPattern?: RegExp;
  /**
   * The institution's public receipt page for a reference, when it has one
   * that the receipt verifier can fetch and read. The URL is always built
   * here from the reference, never taken from SMS text (which an attacker
   * holding the handset controls).
   */
  receiptUrl?: (reference: string) => string;
}

const REFERENCE_RE = /^[A-Z0-9]{6,25}$/;

export const INSTITUTIONS: readonly InstitutionSpec[] = [
  // Wallets
  {
    id: 'telebirr',
    name: 'telebirr',
    kind: 'wallet',
    senders: ['telebirr', '127', 'ethiotelecom', 'ethio telecom'],
    referencePatterns: [
      /transaction\s+number\s+is\s*[:\s]*([A-Z0-9]{6,25})/i,
      // The Amharic credit as telebirr sends it (22 Nov 2026): "የሂሳብ እንቅስቃሴ ቁጥርዎ DKM7JB8UWR ነዉ".
      /የሂሳብ\s*እንቅስቃሴ\s*ቁጥርዎ?\s*[:\s]*([A-Z0-9]{6,25})/,
    ],
    receiptPattern: /(https?:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]{6,25}))/i,
    // Public, no auth; an unknown reference returns a distinguishable page.
    receiptUrl: (reference) => `https://transactioninfo.ethiotelecom.et/receipt/${reference}`,
  },
  {
    id: 'cbe',
    name: 'Commercial Bank of Ethiopia',
    kind: 'bank',
    senders: ['CBE', 'CBEBirr', 'CBE-Birr', 'CBEBIRR', '847'],
    // CBE links a receipt, but apps.cbe.com.et refuses connections from
    // outside its network, so CBE is not receipt-verifiable (no receiptUrl):
    // balance reconciliation covers it instead.
    // Current credits (22 Nov 2026) carry no "Ref No": their only reference is in the receipt
    // link, "https://mbreciept.cbe.com.et/v2-<token>" (a CBE transfer) or
    // "https://apps.cbe.com.et:100/BranchReceipt/FT…&<account>" (from telebirr), read uppercase.
    receiptPattern:
      /(https?:\/\/(?:apps\.cbe\.com\.et[^\s]*?[?&]id=|apps\.cbe\.com\.et(?::\d+)?\/BranchReceipt\/|mbreciept\.cbe\.com\.et\/(?:v\d+-)?)([A-Z0-9]{6,25}))(?![A-Z0-9])/i,
  },
  {
    id: 'mpesa',
    name: 'M-PESA Ethiopia',
    kind: 'wallet',
    senders: ['MPESA', 'M-PESA', 'Safaricom', 'SAFARICOM'],
    creditMarkers: [/you\s+have\s+received/i, /confirmed\.?\s*you\s+have\s+received/i],
  },
  { id: 'ebirr', name: 'E-Birr', kind: 'wallet', senders: ['EBIRR', 'E-Birr', 'eBirr'] },
  { id: 'hellocash', name: 'HelloCash', kind: 'wallet', senders: ['HelloCash', 'HELLOCASH'] },
  { id: 'amole', name: 'Amole (Dashen Bank)', kind: 'wallet', senders: ['Amole', 'AMOLE'] },

  // Banks. None below CBE has a verified reference pattern yet (that needs a
  // real SMS); they use the shared patterns, and a message that does not
  // parse lands in the review queue rather than being lost.
  {
    id: 'awash',
    name: 'Awash Bank',
    kind: 'bank',
    senders: ['Awash', 'AWASH', 'AwashBank', 'AwashBirr', '901'],
  },
  // Distinct from `amole`: Dashen the bank account, not Dashen's wallet.
  {
    id: 'dashen',
    name: 'Dashen Bank',
    kind: 'bank',
    senders: ['Dashen', 'DASHEN', 'DashenBank', '996'],
  },
  {
    id: 'abyssinia',
    name: 'Bank of Abyssinia',
    kind: 'bank',
    senders: ['BoA', 'BOA', 'Abyssinia', 'AbyssiniaBank', 'BoAMobile', '815'],
  },
  {
    id: 'coop',
    name: 'Cooperative Bank of Oromia',
    kind: 'bank',
    senders: ['CBO', 'CoopPay', 'Coop', 'COOP', 'COOPAY', 'Coopay-eBirr', '841'],
  },
  { id: 'wegagen', name: 'Wegagen Bank', kind: 'bank', senders: ['Wegagen', 'WEGAGEN'] },
  { id: 'hibret', name: 'Hibret Bank', kind: 'bank', senders: ['Hibret', 'HIBRET', 'United'] },
  { id: 'nib', name: 'Nib International Bank', kind: 'bank', senders: ['NIB', 'NibBank'] },
  { id: 'zemen', name: 'Zemen Bank', kind: 'bank', senders: ['Zemen', 'ZEMEN'] },
  { id: 'oromia', name: 'Oromia Bank', kind: 'bank', senders: ['OIB', 'Oromia', 'OromiaBank'] },
  { id: 'berhan', name: 'Berhan Bank', kind: 'bank', senders: ['Berhan', 'BERHAN'] },
  { id: 'abay', name: 'Abay Bank', kind: 'bank', senders: ['Abay', 'ABAY'] },
  { id: 'enat', name: 'Enat Bank', kind: 'bank', senders: ['Enat', 'ENAT'] },
  { id: 'bunna', name: 'Bunna Bank', kind: 'bank', senders: ['Bunna', 'BUNNA'] },
  { id: 'lion', name: 'Lion International Bank', kind: 'bank', senders: ['Lion', 'LIB'] },
  { id: 'amhara', name: 'Amhara Bank', kind: 'bank', senders: ['Amhara', 'AmharaBank', 'AMB'] },
  { id: 'siinqee', name: 'Siinqee Bank', kind: 'bank', senders: ['Siinqee', 'SIINQEE'] },
  { id: 'tsehay', name: 'Tsehay Bank', kind: 'bank', senders: ['Tsehay', 'TSEHAY'] },
  { id: 'ahadu', name: 'Ahadu Bank', kind: 'bank', senders: ['Ahadu', 'AHADU'] },
  { id: 'hijra', name: 'Hijra Bank', kind: 'bank', senders: ['Hijra', 'HIJRA'] },
  { id: 'zamzam', name: 'ZamZam Bank', kind: 'bank', senders: ['ZamZam', 'ZAMZAM'] },
  { id: 'shabelle', name: 'Shabelle Bank', kind: 'bank', senders: ['Shabelle', 'SHABELLE'] },
  { id: 'addis', name: 'Addis International Bank', kind: 'bank', senders: ['AdIB', 'AddisBank'] },
  { id: 'debub', name: 'Debub Global Bank', kind: 'bank', senders: ['Debub', 'DGB'] },
  { id: 'gadaa', name: 'Gadaa Bank', kind: 'bank', senders: ['Gadaa', 'GADAA'] },
  { id: 'goh', name: 'Goh Betoch Bank', kind: 'bank', senders: ['Goh', 'GohBetoch'] },
  { id: 'global', name: 'Global Bank Ethiopia', kind: 'bank', senders: ['Global', 'GBE'] },
  { id: 'rammis', name: 'Rammis Bank', kind: 'bank', senders: ['Rammis', 'RAMMIS'] },
  { id: 'sidama', name: 'Sidama Bank', kind: 'bank', senders: ['Sidama', 'SIDAMA'] },
];

const BY_ID = new Map(INSTITUTIONS.map((spec) => [spec.id, spec]));

function normaliseSender(sender: string): string {
  return sender.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BY_SENDER = new Map<string, InstitutionSpec>();
for (const spec of INSTITUTIONS) {
  for (const sender of spec.senders) BY_SENDER.set(normaliseSender(sender), spec);
}

export function institutionById(id: string): InstitutionSpec | null {
  return BY_ID.get(id) ?? null;
}

/** Institutions whose receipt page the verifier can read (today: telebirr). */
export const RECEIPT_VERIFIABLE_INSTITUTIONS: readonly InstitutionSpec[] = INSTITUTIONS.filter(
  (spec) => spec.receiptUrl !== undefined,
);

/** The institution behind an SMS sender address, when we recognise it. */
export function institutionFromSender(sender: string | null | undefined): InstitutionSpec | null {
  if (!sender) return null;
  const key = normaliseSender(sender);
  if (!key) return null;
  const exact = BY_SENDER.get(key);
  if (exact) return exact;
  // Sender addresses often arrive decorated ("CBEBank", "AwashBankSMS").
  for (const [candidate, spec] of BY_SENDER) {
    if (candidate.length >= 3 && (key.includes(candidate) || candidate.includes(key))) {
      return spec;
    }
  }
  return null;
}

const CREDIT_MARKERS: readonly RegExp[] = [
  /you\s+have\s+received/i,
  /has\s+been\s+credited/i,
  /credited\s+(?:to|with|by)/i,
  /credit(?:ed)?\s+(?:of\s+)?(?:ETB|Birr)/i,
  /deposit(?:ed)?\s+(?:of\s+)?(?:ETB|Birr)/i,
  /received\s+(?:ETB|Birr)/i,
  /transfer(?:red)?\s+(?:to\s+)?your\s+account/i,
  /ተቀብለዋል/,
  /ገቢ\s*(?:ተደርጓል|ሆኗል|ተደርጎልዎታል)/,
  /ገቢ\s*ተደርጎ/,
];

const DEBIT_MARKERS: readonly RegExp[] = [
  /you\s+have\s+(?:transferred|sent|paid)/i,
  /has\s+been\s+debited/i,
  /debited\s+(?:from|with|for|by)/i,
  /debit(?:ed)?\s+(?:of\s+)?(?:ETB|Birr)/i,
  /withdraw(?:n|al)/i,
  /purchase\s+of/i,
  /ከሂሳብዎ/,
  /ተቀንሷል/,
  /ልከዋል/,
  /ከፍለዋል/,
  /ወጪ\s*(?:ተደርጓል|ሆኗል)/,
];

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /transaction\s+number\s+is\s*[:\s]*([A-Z0-9]{6,25})/i,
  /(?:Ref(?:erence)?|Txn|Transaction|Trx|Receipt)\s*(?:No\.?|Number|ID|#)?\s*[:\s]\s*([A-Z0-9]{6,25})/i,
  /\b(?:VAT\s*)?Receipt\s*(?:No\.?|Number)?\s*[:\s]\s*([A-Z0-9]{6,25})/i,
  /(?:የግብይት|ትራንዛክሽን|ደረሰኝ)\s*(?:ቁጥር)?\s*[:\s]*([A-Z0-9]{6,25})/,
];

/**
 * A currency figure, "ETB 100.00" or "100.00 ETB". The leading `\d` matters:
 * `[\d,]+` alone matches the comma in "Dear customer, ETB 450.22".
 */
const AMOUNT_GLOBAL =
  /(?:ETB|Birr|ብር)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:ETB|Birr|ብር)/gi;

/** A figure introduced by one of these is the resulting balance, not the payment. */
const BALANCE_CONTEXT = /(balance|bal\.?|ቀሪ\s*ሂሳብ|ቀሪ)\s*(?:is|of|:)?\s*$/i;

/** A mobile number not glued to other digits (account numbers contain 9-digit runs). */
const PHONE = /(?<!\d)(?:\+?251|0)?([79]\d{8})(?!\d)/;
/**
 * A number the institution masked, "(2519****3670)": 251 or 0, then nine places of which some are
 * `*` and at least four are digits. Kept for credits only, as "+2519****3670" (smsPhoneFits).
 */
const MASKED_PHONE = /(?<![\d*])(?:\+?251|0)([79*][\d*]{8})(?![\d*])/;
/** CBE names the payer after the masked account: "from account 1********8946 (NAME)". */
const FROM_ACCOUNT_NAME = /from\s+account\s+[\d*]+\s*\(([^()]{2,60})\)/i;
/** The Amharic "from NAME(…)": "ከ naod getachew(2519****3670)". */
const FROM_NAME_AM = /ከ\s+([A-Za-zሀ-፿][A-Za-zሀ-፿ .'-]{1,60}?)\s*\(/;
/** `\s+\d` stops the name before an account or phone number follows it. */
const FROM_NAME = /from\s+([A-Za-zሀ-፿][A-Za-zሀ-፿ .'-]{1,60}?)(?:\s*\(|\s+on\s|\s*,|\.|\s+\d|$)/i;
const DATE = /on\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})(?:\s+at\s+([\d:]+\s*(?:AM|PM)?))?/i;
/** The Amharic "on 22/11/2026 23:53:23" (በ = on). */
const DATE_AM = /በ\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/;
const BALANCE_VALUE =
  /(?:balance|ቀሪ\s*ሂሳብ)\s*(?:is|:)?\s*(?:ETB|Birr|ብር)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i;

/** Longest SMS text the parser looks at (concatenated SMS are well under this). */
export const SMS_MAX_LENGTH = 2000;

/** Birr text → santim, or null when it is not an exact amount ("100,37" is refused). */
export function smsBirrToSantim(text: string): Santim | null {
  try {
    return parseBirr(text);
  } catch {
    return null;
  }
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** The first currency figure not introduced by a balance word (some banks lead with the balance). */
function extractAmount(text: string): Santim | null {
  for (const match of text.matchAll(AMOUNT_GLOBAL)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const index = match.index;
    if (BALANCE_CONTEXT.test(text.slice(Math.max(0, index - 30), index))) continue;
    const value = smsBirrToSantim(raw);
    if (value !== null && value > 0n) return value;
  }
  return null;
}

function extractReference(text: string, spec: InstitutionSpec): string | null {
  for (const pattern of [...(spec.referencePatterns ?? []), ...REFERENCE_PATTERNS]) {
    const found = pattern.exec(text)?.[1];
    if (found) return found.toUpperCase();
  }
  const fromReceipt = spec.receiptPattern?.exec(text)?.[2];
  return fromReceipt ? fromReceipt.toUpperCase() : null;
}

/**
 * Ethiopian SMS dates are dd/mm/yyyy in EAT (UTC+3). Null rather than a
 * wrong date: the gateway's receive time is a better clock than a misread one.
 */
function parseSmsDate(date: string | undefined, time: string | undefined): Date | null {
  if (!date) return null;
  const [dd, mm, yyyyRaw] = date.split(/[/-]/).map(Number);
  if (!dd || !mm || !yyyyRaw || mm > 12 || dd > 31) return null;
  const yyyy = yyyyRaw < 100 ? 2000 + yyyyRaw : yyyyRaw;
  let hours = 0;
  let minutes = 0;
  if (time) {
    const t = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(time);
    if (t?.[1] && t[2]) {
      hours = Number(t[1]);
      minutes = Number(t[2]);
      const meridiem = t[3]?.toUpperCase();
      if (hours > 23 || minutes > 59 || (meridiem && hours > 12)) return null;
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
    }
  }
  const utc = Date.UTC(yyyy, mm - 1, dd, hours - 3, minutes);
  const check = new Date(Date.UTC(yyyy, mm - 1, dd));
  // Date.UTC rolls 31/02 over into March: refuse it.
  if (check.getUTCDate() !== dd || check.getUTCMonth() !== mm - 1) return null;
  return Number.isFinite(utc) ? new Date(utc) : null;
}

/** "+2519****3670" for a masked number with at least four visible digits, else null. */
function maskedPhone(text: string): string | null {
  const rest = MASKED_PHONE.exec(text)?.[1];
  if (!rest || !rest.includes('*')) return null;
  if ((rest.match(/\d/g) ?? []).length < 4) return null;
  return `+251${rest}`;
}

/**
 * Whether the payer number an SMS carries can be `phone` (E.164): equal for a full number,
 * equal at every visible place for a masked one ("+2519****3670"). Null when the SMS carries
 * none. False sends a credit to staff as a third-party payment, never to the player.
 */
export function smsPhoneFits(smsPhone: string | null, phone: string | null): boolean | null {
  if (smsPhone === null) return null;
  // A deposit without a phone cannot be the payer the SMS names (as before: flagged).
  if (phone === null) return false;
  if (!smsPhone.includes('*')) return smsPhone === phone;
  if (smsPhone.length !== phone.length) return false;
  for (let i = 0; i < smsPhone.length; i += 1) {
    if (smsPhone[i] !== '*' && smsPhone[i] !== phone[i]) return false;
  }
  return true;
}

/**
 * Parses `text` as a message from `spec`. Null unless direction, amount and
 * reference are all unambiguous; the other fields degrade one by one.
 */
export function parseSmsWithSpec(text: string, spec: InstitutionSpec): ParsedSms | null {
  if (typeof text !== 'string' || !text.trim() || text.length > SMS_MAX_LENGTH) return null;
  const isCredit = matchesAny(text, [...(spec.creditMarkers ?? []), ...CREDIT_MARKERS]);
  const isDebit = matchesAny(text, [...(spec.debitMarkers ?? []), ...DEBIT_MARKERS]);
  if (isCredit === isDebit) return null;

  const amount = extractAmount(text);
  if (amount === null) return null;
  const reference = extractReference(text, spec);
  if (!reference || !REFERENCE_RE.test(reference)) return null;

  const balanceRaw = BALANCE_VALUE.exec(text)?.[1];
  const date = DATE.exec(text) ?? DATE_AM.exec(text);
  const phoneDigits = PHONE.exec(text)?.[1];
  const fullPhone = phoneDigits ? normalizeEthiopianMsisdn(phoneDigits) : null;
  return {
    institution: spec.id,
    direction: isCredit ? 'credit' : 'debit',
    amount,
    reference,
    counterpartyName:
      (
        FROM_ACCOUNT_NAME.exec(text)?.[1] ??
        FROM_NAME_AM.exec(text)?.[1] ??
        FROM_NAME.exec(text)?.[1]
      )?.trim() ?? null,
    // A masked payer number still tells a third party apart (smsPhoneFits); a debit keeps only a
    // full number, as a masked one proves nothing about where a payout went.
    counterpartyPhone: fullPhone ?? (isCredit ? maskedPhone(text) : null),
    balance: balanceRaw ? smsBirrToSantim(balanceRaw) : null,
    occurredAt: date ? parseSmsDate(date[1], date[2]) : null,
  };
}

/**
 * How strongly a message looks like it came from this institution rather than
 * merely being parseable by its spec (the shared markers parse most bank SMS
 * under any spec). Only decides the label; the amount and reference are the
 * same whichever spec parsed them.
 */
function specificity(text: string, spec: InstitutionSpec): number {
  let score = 0;
  if (spec.receiptPattern?.test(text)) score += 2;
  if (spec.referencePatterns?.some((pattern) => pattern.test(text))) score += 1;
  if (spec.creditMarkers?.some((pattern) => pattern.test(text))) score += 1;
  return score;
}

/**
 * Parses a confirmation SMS from any registered institution. `hint` is the
 * SMS sender address or an institution id: an optimisation, never a gate, so
 * an unrecognised sender still parses against the whole registry. Without a
 * sender, a plain bank message with no distinctive marker is attributed to
 * the best-scoring spec (the payment is right; the label is a guess).
 */
export function parseSms(text: string, hint?: string | null): ParsedSms | null {
  const hinted = hint ? (institutionById(hint.toLowerCase()) ?? institutionFromSender(hint)) : null;
  if (hinted) {
    const result = parseSmsWithSpec(text, hinted);
    if (result) return result;
  }
  let best: ParsedSms | null = null;
  let bestScore = -1;
  for (const spec of INSTITUTIONS) {
    if (spec === hinted) continue;
    const score = specificity(text, spec);
    if (score <= bestScore) continue;
    const result = parseSmsWithSpec(text, spec);
    if (result) {
      best = result;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A bare transaction reference a player pasted ("CA999DASAD"), or null.
 * Institutions print these as 6–25 uppercase letters and digits.
 */
export function bareSmsReference(text: string): string | null {
  const cleaned = text.trim().toUpperCase();
  return REFERENCE_RE.test(cleaned) ? cleaned : null;
}

/**
 * The reference in what a player pasted: a whole confirmation SMS, or just
 * the transaction number. A lookup key only, never evidence of payment.
 */
export function pastedSmsReference(text: string): string | null {
  if (typeof text !== 'string' || text.length > SMS_MAX_LENGTH) return null;
  return parseSms(text)?.reference ?? bareSmsReference(text);
}
