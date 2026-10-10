import type { Messages } from './messages/en';

/** Every dotted path to a leaf string, e.g. `'common.nav.home'`. */
type LeafPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = LeafPaths<Messages>;

/** Values substituted for `{name}` placeholders. */
export type MessageVars = Readonly<Record<string, string | number | bigint>>;

export type Translator = (key: MessageKey, vars?: MessageVars) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replaces `{name}` placeholders; unknown placeholders are left as they are. */
export function interpolate(template: string, vars?: MessageVars): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Names of the `{placeholders}` in a message, sorted and de-duplicated. */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))].sort();
}

/** Looks up a dotted key; returns undefined when the path does not end at a string. */
export function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * A `t(key, vars)` function over one locale's messages. A missing key (only
 * possible through an unchecked cast) renders as the key itself so it is easy
 * to spot instead of crashing the page.
 */
export function createTranslator(messages: Messages): Translator {
  return (key, vars) => interpolate(lookup(messages, key) ?? key, vars);
}
