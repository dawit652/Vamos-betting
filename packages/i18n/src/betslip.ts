import { withFallback } from './fallback';
import type { Locale } from './locales';
import { sportsbook as am } from './messages/am/sportsbook';
import type { Messages } from './messages/en';
import { sportsbook as en } from './messages/en/sportsbook';
import { sportsbook as om } from './messages/om/sportsbook';
import { sportsbook as ti } from './messages/ti/sportsbook';

export type BetslipMessages = Messages['sportsbook']['betslip'];

/**
 * The betslip's own texts (`sportsbook.betslip.*`) in every locale, for the
 * player app's lazily loaded betslip code: pages do not send them with every
 * response (they are the largest part of the sportsbook messages), the
 * betslip brings them along. Only the sportsbook messages are imported here,
 * never the whole message catalogue. Untranslated keys fall back to English.
 */
const BY_LOCALE = { am: am.betslip, en: en.betslip, om: om.betslip, ti: ti.betslip };

export function betslipMessages(locale: Locale): BetslipMessages {
  return withFallback<BetslipMessages>(en.betslip, BY_LOCALE[locale] ?? {});
}
