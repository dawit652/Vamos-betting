import { listReviewItems, listUnresolvedObservations, type ScrapeReviewItem } from '@vamos/db';
import { loadAliasInputs } from '@vamos/db';
import { catalogueGaps, type GapObservation } from '@vamos/scraper';
import { csvLine } from './csv';
import {
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  table,
  UsageError,
  type CliEnv,
} from './io';

/** Same ceiling as listUnresolvedObservations: a longer backlog is cut and said so. */
const OBSERVATION_LIMIT = 20_000;
const PAGE = 500;

/** The normalised spellings that have an OPEN unknown_team item with an unknown (not ambiguous) name. */
async function openUnknownSpellings(
  items: (after?: { createdAt: Date; id: string }) => Promise<ScrapeReviewItem[]>,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let after: { createdAt: Date; id: string } | undefined; ;) {
    const page = await items(after);
    for (const item of page) {
      const reasons = Array.isArray(item.payload.reasons) ? item.payload.reasons : [];
      if (reasons.includes('ambiguous_name')) continue;
      // Subject key: `<sport>|<normalised name>`.
      const bar = item.subjectKey.indexOf('|');
      out.add(bar < 0 ? item.subjectKey : item.subjectKey.slice(bar + 1));
    }
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) return out;
    after = { createdAt: last.createdAt, id: last.id };
  }
}

/**
 * `review gaps [--competition slug] [--csv | --json]`: the clubs sources use that the catalogue
 * does not have, per competition and normalised spelling, with the sources and the number of
 * observations behind each and when it was first seen. A spelling is listed while it has an OPEN
 * unknown_team review item (a dismissed one is a decision, an ambiguous one an alias to add, not a
 * missing club). `--csv` prints `competition,spelling,sources,rows,first_seen` (sources joined by
 * `;`) for `add club` review. Read-only.
 */
export async function reviewGaps(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    competition: { type: 'string' },
    csv: { type: 'boolean' },
  });
  noPositionals(parsed);
  if (parsed.values.csv === true && parsed.values.json === true) {
    throw new UsageError('--csv and --json cannot be used together');
  }
  const wantedCompetition = optionalString(parsed, 'competition');
  const db = await env.database();

  const [observations, wanted, inputs] = await Promise.all([
    listUnresolvedObservations(db, { limit: OBSERVATION_LIMIT }),
    openUnknownSpellings((after) =>
      listReviewItems(db, {
        status: 'open',
        kind: 'unknown_team',
        limit: PAGE,
        ...(after === undefined ? {} : { after }),
      }),
    ),
    loadAliasInputs(db, 'football'),
  ]);
  const slugs = new Map(inputs.competitions.map((c) => [c.id, c.slug]));
  const gapInput: GapObservation[] = observations.map((o) => ({
    sourceId: o.sourceId,
    competition:
      o.competitionId === null
        ? `?${o.competitionRaw}`
        : (slugs.get(o.competitionId) ?? `?${o.competitionRaw}`),
    homeRaw: o.homeRaw,
    awayRaw: o.awayRaw,
    homeResolved: o.homeTeamId !== null,
    awayResolved: o.awayTeamId !== null,
    firstSeenAt: o.firstSeenAt,
  }));
  const rows = catalogueGaps(gapInput, { wanted }).filter(
    (r) => wantedCompetition === undefined || r.competition === wantedCompetition,
  );
  if (observations.length >= OBSERVATION_LIMIT) {
    env.err(`note: only the ${OBSERVATION_LIMIT} oldest unresolved observations were read`);
  }

  if (parsed.values.csv === true) {
    env.out(csvLine(['competition', 'spelling', 'sources', 'rows', 'first_seen']));
    for (const r of rows) {
      env.out(
        csvLine([
          r.competition,
          r.spelling,
          r.sources.join(';'),
          String(r.rows),
          r.firstSeen.toISOString(),
        ]),
      );
    }
    return EXIT_OK;
  }
  emit(
    env,
    parsed,
    {
      gaps: rows.map((r) => ({
        competition: r.competition,
        spelling: r.spelling,
        normalized: r.normalized,
        sources: r.sources,
        rows: r.rows,
        firstSeen: r.firstSeen.toISOString(),
      })),
    },
    rows.length === 0
      ? ['no catalogue gaps']
      : [
          ...table(
            ['competition', 'spelling', 'sources', 'rows', 'first seen'],
            rows.map((r) => [
              r.competition,
              r.spelling,
              r.sources.join(';'),
              String(r.rows),
              r.firstSeen.toISOString(),
            ]),
          ),
          `${rows.length} spelling(s) missing from the catalogue (open unknown_team items only; --csv for review)`,
        ],
  );
  return EXIT_OK;
}
