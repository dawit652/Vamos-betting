import type { Messages } from '../en';
import { account } from './account';
import { common } from './common';
import { sportsbook } from './sportsbook';

/** Amharic, the default locale. Must translate every key (enforced by the `Messages` type). */
export const am: Messages = { common, sportsbook, account };
