import { listSources } from '@vamos/db';
import {
  coverageMatrix,
  MIN_INDEPENDENT_SOURCES,
  sourceCapabilities,
  type CoverageEntry,
} from '@vamos/scraper';
import { EXIT_OK, emit, noPositionals, parseCommandArgs, table, type CliEnv } from './io';
import { competitionResolver } from '../lib/source-competition';

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/**
 * `sources coverage [--json]`: for each competition, which ENABLED upstreams give fixtures,
 * full-time scores, half-time scores and a stated score basis, from the source configs and what
 * their adapters yield (sourceCapabilities). A competition with fewer than two full-time
 * upstreams is flagged `single-result-upstream`: rule R2 needs two independent ones. Read-only.
 */
export async function sourcesCoverage(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db = await env.database();
  const sources = (await listSources(db)).filter((s) => s.enabled);
  const resolve = await competitionResolver(db);

  const entries: CoverageEntry[] = [];
  const skipped: { sourceId: string; reason: string }[] = [];
  for (const source of sources) {
    const result = sourceCapabilities(source);
    if (!result.ok) {
      skipped.push({ sourceId: source.id, reason: result.errors.join('; ') });
      continue;
    }
    const caps = result.capabilities;
    const labels = caps.competitions.map((label) => resolve(source, label).key);
    if (caps.competitionPerRecord) labels.push('(per record)');
    for (const competition of new Set(labels)) {
      entries.push({
        competition,
        sourceId: source.id,
        upstream: source.upstream,
        capabilities: caps,
      });
    }
  }

  const rows = coverageMatrix(entries).map((row) => ({
    ...row,
    flags: row.singleResultUpstream ? ['single-result-upstream'] : [],
  }));
  const lines =
    rows.length === 0
      ? ['no enabled sources']
      : [
          ...table(
            ['competition', 'sources', 'upstreams', 'fixtures', 'FT', 'HT', 'basis known', 'flags'],
            rows.map((r) => [
              r.competition,
              String(r.sources),
              String(r.upstreams),
              String(r.fixtureUpstreams),
              String(r.fullTimeUpstreams),
              String(r.halfTimeUpstreams),
              yesNo(r.basisKnown),
              r.flags.join(' '),
            ]),
          ),
          '',
          'fixtures, FT, HT: distinct upstreams that give fixtures, full-time scores, half-time scores.',
          `basis known: a full-time upstream states regular time or extra time. single-result-upstream: fewer than ${MIN_INDEPENDENT_SOURCES} FT upstreams (rule R2).`,
          'competitions starting with ? did not resolve in the catalogue; enabled sources only.',
          ...skipped.map((s) => `skipped ${s.sourceId}: ${s.reason}`),
        ];
  emit(env, parsed, { competitions: rows, skipped }, lines);
  return EXIT_OK;
}
