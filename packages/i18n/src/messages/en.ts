/**
 * English is the source locale: its shape defines the `Messages` type that
 * every other locale must satisfy. Nested keys follow `area.key`.
 */
export const en = {
  app: {
    name: 'Vamos',
    tagline: 'Sports betting made simple',
  },
  demo: {
    banner: 'DEMO – play money only. No real money is used.',
  },
  rg: {
    ageNotice: '21+ only. Bet responsibly.',
  },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof en>;
