import type { Metadata } from 'next';
import { MatchList } from '@/components/sportsbook/MatchList';
import { SearchIcon, SportsbookFrame } from '@/components/sportsbook/SportsbookFrame';
import { getT } from '@/i18n/server';
import { searchEvents } from '@/lib/api/catalog';
import { DEFAULT_SPORT, routes } from '@/lib/routes';

/** The API's limits for `q` (EventSearchQuery). */
const MIN_QUERY = 2;
const MAX_QUERY = 60;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('sportsbook.search.title'), robots: { index: false } };
}

/** The search text of `?q=`: trimmed, and undefined when it is too short to search for. */
function parseQuery(value: string | string[] | undefined): string | undefined {
  const q = (Array.isArray(value) ? value[0] : value)?.trim().slice(0, MAX_QUERY);
  return q !== undefined && q.length >= MIN_QUERY ? q : undefined;
}

/**
 * Match search (`/search?q=`): a plain GET form, answered on the server. Finds
 * live and coming matches of every sport by team, league or Game ID.
 */
export default async function SearchPage(props: PageProps<'/search'>) {
  const [searchParams, t] = await Promise.all([props.searchParams, getT()]);
  const q = parseQuery(searchParams.q);
  const results = q === undefined ? null : await searchEvents(q);
  return (
    <SportsbookFrame sport={DEFAULT_SPORT} search>
      <div className="px-3 lg:px-0">
        <h1 className="mb-2 text-lg font-extrabold">{t('sportsbook.search.title')}</h1>
        <form action={routes.search} role="search" className="mb-3 flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            minLength={MIN_QUERY}
            maxLength={MAX_QUERY}
            required
            autoFocus={q === undefined}
            enterKeyHint="search"
            aria-label={t('sportsbook.search.label')}
            placeholder={t('sportsbook.search.label')}
            className="input min-w-0 flex-1"
          />
          <button type="submit" className="btn btn-primary flex-none gap-1.5">
            <SearchIcon />
            {t('sportsbook.search.submit')}
          </button>
        </form>
        {results === null ? (
          <p className="card text-center text-muted">{t('sportsbook.search.hint')}</p>
        ) : results.items.length === 0 ? (
          <p className="card text-center text-muted" role="status">
            {t('sportsbook.search.empty', { q: q ?? '' })}
          </p>
        ) : (
          <h2 className="mb-2 text-xxs font-bold tracking-wider text-muted uppercase">
            {t('sportsbook.search.results', { q: q ?? '' })}
          </h2>
        )}
      </div>
      {results !== null && results.items.length > 0 ? <MatchList events={results.items} /> : null}
    </SportsbookFrame>
  );
}
