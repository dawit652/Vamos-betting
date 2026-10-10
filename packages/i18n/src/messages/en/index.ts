import { account } from './account';
import { common } from './common';
import { sportsbook } from './sportsbook';

/**
 * English, the source locale. Its shape defines the `Messages` type that every
 * other locale must satisfy. Keys are addressed as `namespace.area.key`, e.g.
 * `common.nav.home`. Each namespace lives in its own file so different features
 * can add keys without touching the same file.
 */
export const en = { common, sportsbook, account } as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof en>;
