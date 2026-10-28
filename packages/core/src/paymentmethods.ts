import { normalizeEthiopianMsisdn } from './phone';
import {
  INSTITUTIONS,
  institutionById,
  type InstitutionKind,
  type InstitutionSpec,
} from './smsparse';

/**
 * How players move money on the SMS rail: the deposit instructions per
 * institution (dial code, app name) and the institutions a payout can go to.
 * Ported from Melabingo's `deposit-methods.ts` and `payout-destinations.ts`.
 */

export interface DepositMethod {
  institution: string;
  /** The brand a player recognises. */
  name: string;
  kind: InstitutionKind;
  /**
   * USSD string, unencoded. Most players pay from the USSD menu (no data
   * needed), so this is the primary path. Only present where verified: a
   * wrong code sends a player into a stranger's menu.
   */
  ussd?: string;
  /** The mobile app's own name. */
  appName?: string;
}

/**
 * Dial codes, each verified against the institution's own instructions or
 * two independent sources. Note `*841#` is Coop and `*847#` is CBE Birr:
 * one digit apart, the easiest mistake on the list.
 */
const METHOD_DETAILS: Readonly<Record<string, { ussd?: string; appName?: string }>> = {
  telebirr: { ussd: '*127#', appName: 'telebirr' },
  cbe: { ussd: '*847#', appName: 'CBE Birr' },
  mpesa: { ussd: '*733#', appName: 'M-PESA' },
  coop: { ussd: '*841#', appName: 'Coopay-eBirr' },
  awash: { ussd: '*901#', appName: 'Awash Wallet' },
  dashen: { ussd: '*996#', appName: 'Dashen Mobile Plus' },
  abyssinia: { ussd: '*815#', appName: 'BoA Mobile' },
};

/** The display model for a collection account's institution (raw id as the name when unknown). */
export function depositMethodFor(institutionId: string): DepositMethod {
  const spec = institutionById(institutionId);
  return {
    institution: institutionId,
    name: spec?.name ?? institutionId,
    kind: spec?.kind ?? 'wallet',
    ...(METHOD_DETAILS[institutionId] ?? {}),
  };
}

/**
 * A `tel:` href that prefills the dialer. The `#` must be percent-encoded:
 * raw, it is a URI fragment and the dialer receives `*127` without its
 * terminator.
 */
export function ussdHref(ussd: string): string {
  return `tel:${ussd.replace(/#/g, '%23')}`;
}

export interface PayoutDestination {
  /** Institution id (stored on the payout account). */
  id: string;
  name: string;
  kind: InstitutionKind;
  /** A wallet is addressed by phone number, a bank by account number. */
  accountKind: 'phone' | 'account';
}

/** Wallets and the two biggest banks first; everything else alphabetically. */
const DESTINATION_PRIORITY: readonly string[] = [
  'telebirr',
  'cbe',
  'mpesa',
  'awash',
  'abyssinia',
  'coop',
];

function rank(id: string): number {
  const index = DESTINATION_PRIORITY.indexOf(id);
  return index === -1 ? DESTINATION_PRIORITY.length : index;
}

function toDestination(spec: InstitutionSpec): PayoutDestination {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    accountKind: spec.kind === 'wallet' ? 'phone' : 'account',
  };
}

/**
 * Where a payout may go: derived from the parser registry, so every
 * destination is one whose confirmation SMS can be reconciled later.
 */
export const PAYOUT_DESTINATIONS: readonly PayoutDestination[] = [...INSTITUTIONS]
  .map(toDestination)
  .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'en'));

const DESTINATIONS_BY_ID = new Map(PAYOUT_DESTINATIONS.map((d) => [d.id, d]));

export function payoutDestination(id: string): PayoutDestination | null {
  return DESTINATIONS_BY_ID.get(id) ?? null;
}

/** A bank account number: 5–30 letters and digits once spaces and dashes are removed, uppercased. */
export function normalizeBankAccountNumber(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s-]/g, '');
  return /^[A-Za-z0-9]{5,30}$/.test(cleaned) ? cleaned.toUpperCase() : null;
}

/**
 * Validates and canonicalises a payout destination the player typed: E.164
 * for a wallet, the cleaned account number for a bank. Null when the
 * institution is unknown or the account does not fit its kind (one generic
 * error for the caller, no hint about which half was wrong). Canonical forms
 * let the unique index on (user, institution, account) see that "0911…" and
 * "+251911…" are one beneficiary, and let a parsed SMS compare equal.
 */
export function normalizePayoutDestination(
  institutionId: string,
  account: string,
): { destination: PayoutDestination; account: string } | null {
  const destination = payoutDestination(institutionId);
  if (!destination) return null;
  const canonical =
    destination.accountKind === 'phone'
      ? normalizeEthiopianMsisdn(account)
      : normalizeBankAccountNumber(account);
  return canonical ? { destination, account: canonical } : null;
}

/**
 * Normalises a person's name for comparison (payout account holder vs the
 * KYC name, SMS sender vs the KYC name): case, spacing and punctuation are
 * ignored. Ethiopic script is kept as is.
 */
export function normalizePersonName(name: string): string {
  return name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether two names name the same person for payout purposes: equal once
 * normalised, or one is the other's first two names (bank SMS often carry
 * "ABEBE KEBEDE" for "ABEBE KEBEDE TESFAYE"). Deliberately strict otherwise:
 * a false match pays a third party.
 */
export function personNamesMatch(a: string, b: string): boolean {
  const left = normalizePersonName(a);
  const right = normalizePersonName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftParts = left.split(' ');
  const rightParts = right.split(' ');
  const [shorter, longer] =
    leftParts.length <= rightParts.length ? [leftParts, rightParts] : [rightParts, leftParts];
  return shorter.length >= 2 && shorter.every((part, i) => longer[i] === part);
}
