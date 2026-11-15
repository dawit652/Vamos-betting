'use client';

import type { EventDetail } from '@vamos/contracts';
import { useId, useMemo, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { localName } from '@/lib/localized';
import { groupMarkets, oddsMarket, type EventRef } from './events';
import { MarketOdds } from './MarketOdds';
import { Chevron } from './Chevron';
import {
  MAIN_SECTION,
  applyFilter,
  buildSections,
  type MarketSection,
  type SectionFilter,
} from './market-sections';

/** Main accordions opened on first view; the rest stay closed to keep the page short. */
const OPEN_GROUPS = 4;

/**
 * The event page's markets: "Main" (today's markets, accordion per type, as
 * before) and one collapsible section per factory group. Chips and a search box
 * show when there are factory groups; sections render their markets only when
 * opened, so the first paint stays light.
 */
export function MarketSections({
  markets,
  event,
  bettingOpen,
}: {
  markets: EventDetail['markets'];
  event: EventRef;
  bettingOpen: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SectionFilter>('all');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  const all = useMemo(
    () => buildSections(markets, (m) => localName(m.name, locale)),
    [markets, locale],
  );
  const hasGroups = all.some((s) => s.id !== MAIN_SECTION);
  const searching = query.trim() !== '';
  const sections = useMemo(
    () =>
      hasGroups
        ? applyFilter(
            buildSections(markets, (m) => localName(m.name, locale), query),
            filter,
          )
        : all,
    [hasGroups, markets, locale, query, filter, all],
  );

  const title = (s: MarketSection) => (s.titleKey === null ? s.fallbackTitle : t(s.titleKey));
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (all.length === 0) {
    return <p className="card text-center text-muted">{t('sportsbook.markets.none')}</p>;
  }
  const single = !hasGroups;
  return (
    <div>
      {hasGroups ? (
        <div className="mb-3 space-y-2">
          <div
            role="group"
            aria-label={t('sportsbook.markets.filterLabel')}
            className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 lg:mx-0 lg:px-0"
          >
            <button
              type="button"
              className="chip"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              {t('sportsbook.markets.all')}
            </button>
            {all.map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip"
                aria-pressed={filter === s.id}
                onClick={() => setFilter(s.id)}
              >
                {title(s)}
              </button>
            ))}
          </div>
          <label htmlFor={searchId} className="sr-only">
            {t('sportsbook.markets.searchLabel')}
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sportsbook.markets.searchPlaceholder')}
            className="input"
          />
        </div>
      ) : null}
      {sections.length === 0 ? (
        <p className="card text-center text-muted">{t('sportsbook.markets.noMatches')}</p>
      ) : (
        <div className="space-y-2">
          {sections.map((section) =>
            section.id === MAIN_SECTION ? (
              <MainSection
                key={section.id}
                section={section}
                heading={single ? null : title(section)}
                event={event}
                bettingOpen={bettingOpen}
                expanded={
                  single || searching || filter === MAIN_SECTION || opened.has(MAIN_SECTION)
                }
                onToggle={() => toggle(MAIN_SECTION)}
                count={t('sportsbook.markets.count', { count: section.markets.length })}
              />
            ) : (
              <GroupSection
                key={section.id}
                section={section}
                heading={title(section)}
                event={event}
                bettingOpen={bettingOpen}
                expanded={searching || filter === section.id || opened.has(section.id)}
                onToggle={() => toggle(section.id)}
                count={t('sportsbook.markets.count', { count: section.markets.length })}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  section: MarketSection;
  event: EventRef;
  bettingOpen: boolean;
  expanded: boolean;
  onToggle: () => void;
  count: string;
}

/** Main is expanded by default: a heading button only when factory groups exist. */
function MainSection({ section, heading, ...rest }: SectionProps & { heading: string | null }) {
  const locale = useLocale();
  const body = (
    <div className="space-y-2">
      {groupMarkets(section.markets).map((group, index) => (
        <details key={group.type} open={index < OPEN_GROUPS} className="group panel">
          <summary className="flex items-center justify-between gap-2 px-3 py-2.5 font-bold">
            <span className="truncate">{localName(group.name, locale)}</span>
            <Chevron />
          </summary>
          <div className="space-y-1.5 px-3 pb-3">
            {group.markets.map((market) => (
              <MarketOdds
                key={market.id}
                event={rest.event}
                market={oddsMarket(market)}
                layout="grid"
                bettingOpen={rest.bettingOpen}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
  if (heading === null) return body;
  return (
    <Collapsible heading={heading} section={section} {...rest}>
      {body}
    </Collapsible>
  );
}

/** A factory group: its markets mount only once the section is opened. */
function GroupSection({ heading, ...props }: SectionProps & { heading: string }) {
  const locale = useLocale();
  return (
    <Collapsible heading={heading} {...props}>
      <div className="space-y-2 px-3 pb-3">
        {props.section.markets.map((market) => (
          <div key={market.id}>
            <p className="mb-1 text-xs text-muted">{localName(market.name, locale)}</p>
            <MarketOdds
              event={props.event}
              market={oddsMarket(market)}
              layout="grid"
              bettingOpen={props.bettingOpen}
            />
          </div>
        ))}
      </div>
    </Collapsible>
  );
}

function Collapsible({
  heading,
  section,
  expanded,
  onToggle,
  count,
  children,
}: SectionProps & { heading: string; children: React.ReactNode }) {
  const panelId = useId();
  return (
    <section className="panel" aria-label={heading} data-section={section.id}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left font-bold"
      >
        <span className="truncate">
          {heading} <span className="text-xs font-normal text-muted">{count}</span>
        </span>
        <span className={expanded ? 'rotate-180' : ''}>
          <Chevron />
        </span>
      </button>
      <div id={panelId} hidden={!expanded}>
        {expanded ? children : null}
      </div>
    </section>
  );
}
