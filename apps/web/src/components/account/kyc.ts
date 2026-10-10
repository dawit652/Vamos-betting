import type { KycResponse } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import type { Tone } from './bets';

/** KYC status chip (pure). */

export type KycStatus = KycResponse['status'];

export const KYC_TONE: Readonly<Record<KycStatus, Tone>> = {
  unverified: 'muted',
  pending: 'pending',
  verified: 'positive',
  rejected: 'negative',
};

export const KYC_LABEL: Readonly<Record<KycStatus, MessageKey>> = {
  unverified: 'account.kyc.status.unverified',
  pending: 'account.kyc.status.pending',
  verified: 'account.kyc.status.verified',
  rejected: 'account.kyc.status.rejected',
};
