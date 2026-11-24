import {
  CompetitionsResponse,
  EventListResponse,
  PublicTicketStatusResponse,
  type EventSummary,
  type LocalizedNameValue,
} from '@vamos/contracts';

/**
 * The bot reads the public catalogue through the API (API_INTERNAL_URL), exactly what the website
 * shows: the same filters, the same market rules and the API's catalogue cache. Every answer is
 * checked against the shared contracts.
 */

export type EventFilter = 'highlights' | 'today' | 'upcoming' | 'live';

export interface FeaturedLeague {
  slug: string;
  name: LocalizedNameValue;
  flag: string;
  eventCount: number;
}

export interface CatalogReader {
  events(query: {
    filter: EventFilter;
    competition?: string;
    limit: number;
  }): Promise<EventSummary[]>;
  featuredLeagues(): Promise<FeaturedLeague[]>;
  /** A shop ticket's public state (GET /tickets/:number); null when no ticket has this number. */
  ticket(number: string): Promise<PublicTicketStatusResponse | null>;
}

/** England, Scotland, Wales and Northern Ireland: subdivision flags (tag sequences), like the website. */
const SUBDIVISION_FLAGS: Readonly<Record<string, string>> = {
  'GB-ENG': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  'GB-SCT': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  'GB-WLS': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  'GB-NIR': '\u{1F1EC}\u{1F1E7}',
};

/** A country's flag emoji from its ISO 3166-1 alpha-2 code; the globe for international ones. */
export function flagOf(countryCode: string | null): string {
  const subdivision =
    countryCode === null ? undefined : SUBDIVISION_FLAGS[countryCode.toUpperCase()];
  if (subdivision !== undefined) return subdivision;
  if (countryCode === null || !/^[A-Za-z]{2}$/.test(countryCode)) return '🌍';
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

export function createCatalogReader(options: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** The bot lists football (the sport most players ask about). */
  sport?: string;
}): CatalogReader {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 5_000;
  const sport = options.sport ?? 'football';

  async function get(path: string, options: { notFound?: 'null' } = {}): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404 && options.notFound === 'null') return null;
    if (!response.ok) throw new Error(`catalogue ${path}: HTTP ${response.status}`);
    return response.json();
  }

  return {
    async events({ filter, competition, limit }) {
      const params = new URLSearchParams({ sport, filter, limit: String(limit) });
      if (competition !== undefined) params.set('competition', competition);
      return EventListResponse.parse(await get(`/events?${params.toString()}`)).items;
    },
    async featuredLeagues() {
      const data = CompetitionsResponse.parse(
        await get(`/sports/${encodeURIComponent(sport)}/competitions`),
      );
      return data.items.flatMap(({ category, competitions }) =>
        competitions
          .filter((c) => c.featured && c.eventCount > 0)
          .map((c) => ({
            slug: c.slug,
            name: c.name,
            flag: flagOf(category.countryCode),
            eventCount: c.eventCount,
          })),
      );
    },
    async ticket(number) {
      const data = await get(`/tickets/${encodeURIComponent(number)}`, { notFound: 'null' });
      return data === null ? null : PublicTicketStatusResponse.parse(data);
    },
  };
}
