import { withFallback } from '../../fallback';
import { en, type Messages } from '../en';
import { account } from './account';
import { common } from './common';
import { sportsbook } from './sportsbook';

/**
 * Tigrinya: prepared, not launched. UNREVIEWED: only the keys in this folder are
 * translated; every other key shows the English text until a native speaker adds it.
 */
export const ti: Messages = {
  common: withFallback(en.common, common),
  sportsbook: withFallback(en.sportsbook, sportsbook),
  account: withFallback(en.account, account),
};
