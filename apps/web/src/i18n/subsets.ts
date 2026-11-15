import type { ClientMessages } from './client';

/**
 * The client's sportsbook messages without the betslip's own texts
 * (`sportsbook.betslip.*`, about 1.4 KB per page): the betslip's lazily loaded
 * code brings them (`@vamos/i18n/betslip`), and the account pages, whose
 * forms reuse some of them (jackpot errors), send the full namespace again
 * (AccountMessages).
 */
export function withoutBetslipMessages(messages: ClientMessages): ClientMessages {
  if (messages.sportsbook === undefined) return messages;
  const { betslip: _betslip, ...sportsbook } = messages.sportsbook;
  return { ...messages, sportsbook: sportsbook as NonNullable<ClientMessages['sportsbook']> };
}
