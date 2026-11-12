import {
  FACTORY_MARKETS,
  canonicalFactoryLine,
  findFactoryMarket,
  resolveFactorySelection,
} from './market-factory';
import {
  MARKET_TYPES,
  type MarketTypeCode,
  type ResolutionInput,
  type SelectionResult,
  marketKey,
  resolveSelection,
} from './markets';

/**
 * One way to settle any stored market (plan task 2.3): today's market types exactly as before
 * (`resolveSelection`), every other type by its market-factory rule (`resolveFactorySelection`),
 * which is the same rule that priced it. A market of neither kind cannot be settled: RangeError.
 */

/** True for one of today's market types (MARKET_TYPES). */
export function isLegacyMarketType(type: string): type is MarketTypeCode {
  return typeof type === 'string' && Object.hasOwn(MARKET_TYPES, type);
}

/** True for a type that only the market factory defines (football, Tier A). */
export function isFactoryOnlyMarketType(type: string): boolean {
  return !isLegacyMarketType(type) && FACTORY_TYPES.has(type);
}

const FACTORY_TYPES: ReadonlySet<string> = new Set(FACTORY_MARKETS.map((m) => m.type));

/** Display order of factory-only markets: after today's types, in catalogue order. */
export const FACTORY_SORT_ORDER_BASE = 1000;

const FACTORY_SORT_ORDER: ReadonlyMap<string, number> = new Map(
  FACTORY_MARKETS.map((m, i) => [factoryKey(m.type, m.line), FACTORY_SORT_ORDER_BASE + i]),
);

function factoryKey(type: string, line: string | null): string {
  return line === null ? type : `${type}:${line}`;
}

/**
 * True when a stored market of this type and line can be settled: one of today's types with a
 * valid line, or a market the factory defines.
 */
export function isSettleableMarket(type: string, line?: string | null): boolean {
  if (isLegacyMarketType(type)) {
    try {
      marketKey(type, line);
      return true;
    } catch {
      return false;
    }
  }
  return findFactoryMarket(type, line) !== undefined;
}

/**
 * Settles one selection of any stored market against the event outcome. Today's types settle
 * exactly as `resolveSelection` does (the factory is proven equal on them); factory-only types by
 * their factory rule. Throws a RangeError for an unknown market or selection, a malformed score,
 * or a half-time score that a market needs and the result lacks.
 */
export function resolveMarketSelection(
  market: { type: string; line?: string | null },
  selection: string,
  input: ResolutionInput,
): SelectionResult {
  if (isLegacyMarketType(market.type)) {
    return resolveSelection({ type: market.type, line: market.line ?? null }, selection, input);
  }
  return resolveFactorySelection(market, selection, input);
}

/** The stored key of a factory-only market ('htft', 'multigoals:1-3'), validated; RangeError otherwise. */
export function factoryMarketKey(type: string, line?: string | null): string {
  const market = findFactoryMarket(type, line);
  if (market === undefined || isLegacyMarketType(type)) {
    throw new RangeError(
      `not a factory-only market: "${type}"${line === null || line === undefined ? '' : ` "${line}"`}`,
    );
  }
  return factoryKey(market.type, canonicalFactoryLine(line));
}

/** The display order of a factory-only market (after today's types). */
export function factoryMarketSortOrder(type: string, line?: string | null): number {
  return (
    FACTORY_SORT_ORDER.get(factoryKey(type, canonicalFactoryLine(line))) ?? Number.MAX_SAFE_INTEGER
  );
}

/**
 * The stored key of any market: `marketKey` for today's types, `factoryMarketKey` for
 * factory-only ones. RangeError for a market of neither kind or an invalid line.
 */
export function anyMarketKey(type: string, line?: string | null): string {
  return isLegacyMarketType(type) ? marketKey(type, line) : factoryMarketKey(type, line);
}
