import type { ChannelFlagsResponse } from '@vamos/contracts';

/** Helpers of the bet-channel display and the read-only channel switches view. */

export const CHANNEL_LABELS: Record<string, string> = {
  web: 'Web',
  sms: 'SMS',
  ussd: 'USSD',
};

/** A bet's channel as shown: known channels get their name, anything else is shown as-is. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

export interface FlagRow {
  key: 'sms' | 'ussd';
  name: string;
  /** The environment variable that switches it. */
  variable: string;
  enabled: boolean;
  aggregator: string;
  /** Short code (SMS) or service code (USSD). */
  code: string;
}

export function flagRows(flags: ChannelFlagsResponse): FlagRow[] {
  return [
    {
      key: 'sms',
      name: 'SMS betting',
      variable: 'SMS_BETTING_ENABLED',
      enabled: flags.sms.enabled,
      aggregator: flags.sms.aggregator,
      code: flags.sms.shortCode,
    },
    {
      key: 'ussd',
      name: 'USSD betting',
      variable: 'USSD_ENABLED',
      enabled: flags.ussd.enabled,
      aggregator: flags.ussd.aggregator,
      code: flags.ussd.serviceCode,
    },
  ];
}
