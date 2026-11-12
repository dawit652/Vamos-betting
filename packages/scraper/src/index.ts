/**
 * @vamos/scraper – the scraping toolkit (docs/scraper.md). No database, Redis
 * or global state: the runner in apps/scraper wires it to both.
 *
 * - types / constants: the observations every adapter produces and the
 *   thresholds the rules use;
 * - fetch, archive: polite HTTP and the raw-snapshot store;
 * - adapters: one parser per source kind (pure functions);
 * - normalize, match: names, times, identity and fixture clustering;
 * - gates: the rules that decide what may reach the catalogue.
 */
export * from './types';
export * from './constants';
export * from './fetch';
export * from './archive';
export * from './normalize';
export * from './match';
export * from './gates';
export * from './league';
export * from './adapters';
