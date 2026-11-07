import { SEARCH_MIN_LENGTH } from '@vamos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { MatchList } from '@/components/sportsbook/MatchList';
import { getLocale, getT } from '@/i18n/server';
import { searchCatalog } from '@/lib/api/catalog';
import { flagEmoji } from '@/lib/flag';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('sportsbook.search.title'), robots: { index: false } };
}

/** The first `q` of the query string (it may repeat), trimmed. */
function queryText(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return (first ?? '').trim();
}

/**
 * Team and league search: a plain GET form, so it works without client
 * JavaScript. Results are server-rendered; leagues link to their pages and the
 * matches use the same rows (and odds buttons) as the lists.
 */
export default async function SearchPage(props: PageProps<'/search'>) {
  const [searchParams, t, locale] = await Promise.all([props.searchParams, getT(), getLocale()]);
  const q = queryText(searchParams.q);
  const tooShort = q !== '' && [...q].length < SEARCH_MIN_LENGTH;
  const results = q === '' || tooShort ? null : await searchCatalog(q);
  const empty = results !== null && results.competitions.length + results.events.length === 0;

  return (
    <div className="pb-4">
      <form
        method="get"
        action={routes.search}
        role="search"
        className="flex flex-wrap items-end gap-2 border-b border-line bg-surface p-3"
      >
        <h1 className="sr-only">{t('sportsbook.search.title')}</h1>
        <div className="min-w-0 flex-1">
          <label htmlFor="search-q" className="mb-1 block text-xs font-semibold text-muted">
            {t('sportsbook.search.label')}
          </label>
          <input
            id="search-q"
            type="search"
            name="q"
            defaultValue={q}
            maxLength={60}
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t('sportsbook.search.placeholder')}
            className="input"
          />
        </div>
        <button type="submit" className="btn btn-primary">
          {t('sportsbook.search.submit')}
        </button>
      </form>

      {tooShort ? (
        <p role="status" className="card m-3 text-center text-muted">
          {t('sportsbook.search.tooShort')}
        </p>
      ) : null}
      {empty ? (
        <p role="status" className="card m-3 text-center text-muted">
          {t('sportsbook.search.empty', { q })}
        </p>
      ) : null}

      {results !== null && results.competitions.length > 0 ? (
        <section aria-labelledby="search-leagues">
          <h2
            id="search-leagues"
            className="px-3 pt-3 pb-1 text-xxs font-bold text-muted uppercase"
          >
            {t('sportsbook.search.leagues')}
          </h2>
          <ul>
            {results.competitions.map((competition) => (
              <li key={`${competition.sport}/${competition.slug}`}>
                <Link
                  href={routes.competition(competition.sport, competition.slug)}
                  prefetch={false}
                  className="list-row flex items-center justify-between gap-2 font-semibold"
                >
                  <span className="min-w-0 truncate">
                    <span aria-hidden="true">{flagEmoji(competition.category.countryCode)}</span>{' '}
                    {localName(competition.name, locale)}
                    <span className="block text-xxs font-normal text-muted">
                      {localName(competition.category.name, locale)} ·{' '}
                      {t(`common.sports.${competition.sport}`)}
                    </span>
                  </span>
                  <span className="flex-none text-xxs font-normal text-muted">
                    {t('sportsbook.leagues.matches', { count: competition.eventCount })} ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {results !== null && results.events.length > 0 ? (
        <section aria-labelledby="search-matches">
          <h2
            id="search-matches"
            className="px-3 pt-3 pb-1 text-xxs font-bold text-muted uppercase"
          >
            {t('sportsbook.search.matches')}
          </h2>
          <MatchList events={results.events} />
        </section>
      ) : null}
    </div>
  );
}
