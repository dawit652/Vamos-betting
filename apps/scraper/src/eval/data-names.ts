import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  nameTokens,
  normalizeName,
  resolveCompetition,
  resolveTeam,
  suggestTeams,
  type AliasIndex,
  type Resolution,
} from '@vamos/scraper';
import {
  argOf,
  buildAdapter,
  catalogueIndex,
  countBy,
  footballTeams,
  ofUrl,
  parseCsv,
  parseDocument,
  pct,
  readEnvelope,
  readOfMatches,
  requiredArg,
  SOURCE_FILE,
  teamId,
} from './data-lib';

/**
 * Measurements 4 and 5 of the data-accuracy evaluation: name resolution against the catalogue
 * (the real `buildAliasIndex` / `resolveTeam` of the pipeline, fed the seed catalogue in memory),
 * an audit for wrong matches, a systematic collision test over all football catalogue teams, and
 * the share of the next 21 days of fixtures that could become events.
 *
 *   tsx src/eval/data-names.ts --data <dir> --out <json> [--now <ISO>]
 *
 * The TRUTH table below is the evaluator's own judgement of which catalogue team (short name) a
 * source club is, or null when the club is not in the catalogue. It does not come from the code
 * under test.
 */

const SOURCE_ID = 'openfootball-en1';

interface LeagueSpec {
  file: string;
  zone: string;
  slug: string;
  label: string;
}
const SEEDED: LeagueSpec[] = [
  { file: 'en.1', zone: 'Europe/London', slug: 'premier-league', label: 'Premier League' },
  { file: 'es.1', zone: 'Europe/Madrid', slug: 'laliga', label: 'LaLiga' },
  { file: 'it.1', zone: 'Europe/Rome', slug: 'serie-a', label: 'Serie A' },
  { file: 'de.1', zone: 'Europe/Berlin', slug: 'bundesliga', label: 'Bundesliga' },
  { file: 'fr.1', zone: 'Europe/Paris', slug: 'ligue-1', label: 'Ligue 1' },
];
const OTHER_FILES = ['en.2', 'en.3', 'pt.1', 'nl.1', 'at.1', 'tr.1'];

const TRUTH: Record<string, Record<string, string | null>> = {
  'en.1': {
    'AFC Bournemouth': 'Bournemouth',
    'Arsenal FC': 'Arsenal',
    'Aston Villa FC': 'Aston Villa',
    'Brentford FC': 'Brentford',
    'Brighton & Hove Albion FC': 'Brighton',
    'Burnley FC': 'Burnley',
    'Chelsea FC': 'Chelsea',
    'Coventry City FC': 'Coventry',
    'Crystal Palace FC': 'Crystal Palace',
    'Everton FC': 'Everton',
    'Fulham FC': 'Fulham',
    'Hull City AFC': 'Hull',
    'Ipswich Town FC': 'Ipswich',
    'Leeds United FC': 'Leeds',
    'Liverpool FC': 'Liverpool',
    'Manchester City FC': 'Man City',
    'Manchester United FC': 'Man Utd',
    'Newcastle United FC': 'Newcastle',
    'Nottingham Forest FC': "Nott'm Forest",
    'Sunderland AFC': 'Sunderland',
    'Tottenham Hotspur FC': 'Tottenham',
    'West Ham United FC': 'West Ham',
    'Wolverhampton Wanderers FC': 'Wolves',
  },
  'es.1': {
    'Athletic Club': 'Athletic Club',
    'CA Osasuna': 'Osasuna',
    'Club Atlético de Madrid': 'Atletico Madrid',
    'Deportivo Alavés': null,
    'Elche CF': null,
    'FC Barcelona': 'Barcelona',
    'Getafe CF': 'Getafe',
    'Girona FC': 'Girona',
    'Levante UD': null,
    'Málaga CF': null,
    'RC Celta de Vigo': 'Celta Vigo',
    'RC Deportivo La Coruña': null,
    'RCD Espanyol de Barcelona': null,
    'RCD Mallorca': null,
    'Rayo Vallecano de Madrid': 'Rayo Vallecano',
    'Real Betis Balompié': 'Real Betis',
    'Real Madrid CF': 'Real Madrid',
    'Real Oviedo': null,
    'Real Racing Club de Santander': null,
    'Real Sociedad de Fútbol': 'Real Sociedad',
    'Sevilla FC': 'Sevilla',
    'Valencia CF': 'Valencia',
    'Villarreal CF': 'Villarreal',
  },
  'it.1': {
    'AC Milan': 'AC Milan',
    'AC Monza': null,
    'AC Pisa 1909': null,
    'ACF Fiorentina': 'Fiorentina',
    'AS Roma': 'Roma',
    'Atalanta BC': 'Atalanta',
    'Bologna FC 1909': 'Bologna',
    'Cagliari Calcio': null,
    'Como 1907': 'Como',
    'FC Internazionale Milano': 'Inter',
    'Frosinone Calcio': null,
    'Genoa CFC': 'Genoa',
    'Hellas Verona FC': null,
    'Juventus FC': 'Juventus',
    'Parma Calcio 1913': null,
    'SS Lazio': 'Lazio',
    'SSC Napoli': 'Napoli',
    'Torino FC': 'Torino',
    'US Cremonese': null,
    'US Lecce': null,
    'US Sassuolo Calcio': null,
    'Udinese Calcio': 'Udinese',
    'Venezia FC': null,
  },
  'de.1': {
    '1. FC Heidenheim 1846': null,
    '1. FC Köln': null,
    '1. FC Union Berlin': 'Union Berlin',
    '1. FSV Mainz 05': 'Mainz',
    'Bayer 04 Leverkusen': 'Leverkusen',
    'Borussia Dortmund': 'Dortmund',
    'Borussia Mönchengladbach': 'Gladbach',
    'Eintracht Frankfurt': 'Frankfurt',
    'FC Augsburg': null,
    'FC Bayern München': 'Bayern',
    'FC Schalke 04': null,
    'FC St. Pauli 1910': null,
    'Hamburger SV': null,
    'RB Leipzig': 'RB Leipzig',
    'SC Freiburg': 'Freiburg',
    'SC Paderborn 07': null,
    'SV 07 Elversberg': null,
    'SV Werder Bremen': 'Werder Bremen',
    'TSG 1899 Hoffenheim': 'Hoffenheim',
    'VfB Stuttgart': 'Stuttgart',
    'VfL Wolfsburg': 'Wolfsburg',
  },
  'fr.1': {
    'AJ Auxerre': 'Auxerre',
    'AS Monaco FC': 'Monaco',
    'Angers SCO': null,
    'ES Troyes AC': null,
    'FC Lorient': null,
    'FC Metz': null,
    'FC Nantes': 'Nantes',
    'Le Havre AC': null,
    'Le Mans FC': null,
    'Lille OSC': 'Lille',
    'OGC Nice': 'Nice',
    'Olympique Lyonnais': 'Lyon',
    'Olympique de Marseille': 'Marseille',
    'Paris FC': null,
    'Paris Saint-Germain FC': 'PSG',
    'RC Strasbourg Alsace': 'Strasbourg',
    'Racing Club de Lens': 'Lens',
    'Stade Brestois 29': 'Brest',
    'Stade Rennais FC 1901': 'Rennes',
    'Toulouse FC': 'Toulouse',
  },
};

/** Real-world spellings of the clubs the task names, as other sources write them. */
const PROBES: Array<{ raw: string; expect: string | null }> = [
  { raw: 'Inter', expect: 'Inter' },
  { raw: 'Inter Milan', expect: 'Inter' },
  { raw: 'Internazionale', expect: 'Inter' },
  { raw: 'FC Internazionale Milano', expect: 'Inter' },
  { raw: 'Inter Miami CF', expect: null },
  { raw: 'Inter de San Carlos', expect: 'Inter San Carlos' },
  { raw: 'Man United', expect: 'Man Utd' },
  { raw: 'Man Utd', expect: 'Man Utd' },
  { raw: 'Manchester Utd', expect: 'Man Utd' },
  { raw: 'Manchester United', expect: 'Man Utd' },
  { raw: 'Man City', expect: 'Man City' },
  { raw: 'Manchester City', expect: 'Man City' },
  { raw: 'Manchester', expect: null },
  { raw: 'Athletic', expect: 'Athletic Club' },
  { raw: 'Athletic Bilbao', expect: 'Athletic Club' },
  { raw: 'Athletic Club Bilbao', expect: 'Athletic Club' },
  { raw: 'Atletico', expect: 'Atletico Madrid' },
  { raw: 'Atlético', expect: 'Atletico Madrid' },
  { raw: 'Atlético Madrid', expect: 'Atletico Madrid' },
  { raw: 'Atletico de Madrid', expect: 'Atletico Madrid' },
  { raw: 'Real Madrid', expect: 'Real Madrid' },
  { raw: 'Real Madrid CF', expect: 'Real Madrid' },
  { raw: 'Real Sociedad', expect: 'Real Sociedad' },
  { raw: 'Real Betis', expect: 'Real Betis' },
  { raw: 'Real', expect: null },
  { raw: 'Köln', expect: null },
  { raw: 'Cologne', expect: null },
  { raw: '1. FC Köln', expect: null },
  { raw: 'FC Koln', expect: null },
  { raw: 'Borussia Dortmund', expect: 'Dortmund' },
  { raw: 'Dortmund', expect: 'Dortmund' },
  { raw: 'BVB', expect: 'Dortmund' },
  { raw: 'Borussia Mönchengladbach', expect: 'Gladbach' },
  { raw: "Borussia M'gladbach", expect: 'Gladbach' },
  { raw: 'Mönchengladbach', expect: 'Gladbach' },
  { raw: 'Monchengladbach', expect: 'Gladbach' },
  { raw: 'Borussia', expect: null },
  { raw: 'Paris', expect: null },
  { raw: 'Paris FC', expect: null },
  { raw: 'Sporting', expect: null },
  { raw: 'Sporting CP', expect: null },
  { raw: 'Sporting Clube de Portugal', expect: null },
  { raw: 'Union', expect: null },
  { raw: 'Union Saint-Gilloise', expect: null },
  { raw: 'Brest', expect: 'Brest' },
  { raw: 'Brentford', expect: 'Brentford' },
  { raw: 'Leeds', expect: 'Leeds' },
  { raw: 'Leeds United', expect: 'Leeds' },
  { raw: 'United', expect: null },
  { raw: 'City', expect: null },
];

const idOf = (r: Resolution): string | null => (r.status === 'resolved' ? r.id : null);
const shortOf = (id: string | null): string | null =>
  id === null ? null : id.replace(/^football:/, '');
const outcomeOf = (r: Resolution): string =>
  r.status === 'resolved' ? `resolved:${r.via}` : r.status;

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

const args = process.argv.slice(2);
const dir = requiredArg(args, 'data');
const out = requiredArg(args, 'out');
const now = new Date(argOf(args, 'now') ?? new Date().toISOString());
const envelope = readEnvelope(SOURCE_FILE);
const index: AliasIndex = catalogueIndex();
const teams = footballTeams();
const resolve = (raw: string, idx: AliasIndex = index): Resolution =>
  resolveTeam(idx, { sportId: 'football', sourceId: SOURCE_ID, raw });

// --- 4a. per league, per season: club names ---------------------------------------------------
const leagueReports: Array<Record<string, unknown>> = [];
const wrongMatches: Array<Record<string, unknown>> = [];
const sameTargetCollisions: Array<Record<string, unknown>> = [];
for (const spec of SEEDED) {
  const truth = TRUTH[spec.file] ?? {};
  const clubs = new Set<string>();
  const perSeason: Record<string, string[]> = {};
  for (const season of ['2025-26', '2026-27']) {
    const of = readOfMatches(join(dir, 'of', season, `${spec.file}.json`));
    const names = [...new Set(of.matches.flatMap((m) => [m.team1, m.team2]))].sort();
    perSeason[season] = names;
    for (const n of names) clubs.add(n);
  }
  const rows = [...clubs].sort().map((raw) => {
    const r = resolve(raw);
    const expected = raw in truth ? (truth[raw] ?? null) : undefined;
    const got = shortOf(idOf(r));
    const sug =
      r.status === 'resolved' ? [] : suggestTeams(index, { sportId: 'football', raw, limit: 3 });
    return {
      raw,
      expected,
      got,
      outcome: outcomeOf(r),
      topSuggestion: sug[0] ? `${shortOf(sug[0].id)} (${sug[0].score})` : null,
      topSuggestionWrong:
        sug[0] !== undefined && expected !== undefined && shortOf(sug[0].id) !== expected,
    };
  });
  const missingTruth = rows.filter((r) => r.expected === undefined).map((r) => r.raw);
  const inCatalogue = rows.filter((r) => r.expected !== null && r.expected !== undefined);
  const notInCatalogue = rows.filter((r) => r.expected === null);
  const resolvedRight = inCatalogue.filter((r) => r.got === r.expected);
  const resolvedWrong = rows.filter((r) => r.got !== null && r.got !== r.expected);
  const needsAlias = inCatalogue.filter((r) => r.got === null);
  for (const w of resolvedWrong) wrongMatches.push({ league: spec.file, ...w });
  const byTarget = new Map<string, string[]>();
  for (const r of rows)
    if (r.got !== null) byTarget.set(r.got, [...(byTarget.get(r.got) ?? []), r.raw]);
  for (const [target, names] of byTarget) {
    if (names.length > 1) sameTargetCollisions.push({ league: spec.file, target, names });
  }
  const catTeams = teams.filter(
    (t) =>
      t.countryCode ===
      (
        { 'en.1': 'GB-ENG', 'es.1': 'ES', 'it.1': 'IT', 'de.1': 'DE', 'fr.1': 'FR' } as Record<
          string,
          string
        >
      )[spec.file],
  );
  leagueReports.push({
    league: spec.file,
    catalogueTeams: catTeams.length,
    distinctSourceClubs: rows.length,
    clubsPerSeason: Object.fromEntries(Object.entries(perSeason).map(([k, v]) => [k, v.length])),
    clubsInCatalogue: inCatalogue.length,
    clubsNotInCatalogue: notInCatalogue.length,
    resolvedWithoutAlias_correct: resolvedRight.length,
    resolvedWithoutAliasRateOfInCatalogue: pct(resolvedRight.length, inCatalogue.length),
    resolvedWithoutAliasRateOfAllClubs: pct(resolvedRight.length, rows.length),
    wrongMatches: resolvedWrong.length,
    needAlias_inCatalogue: needsAlias.map((r) => `${r.raw} -> ${r.expected}`),
    notInCatalogue: notInCatalogue.map((r) => r.raw),
    topSuggestionForUnresolved: rows
      .filter((r) => r.got === null)
      .map((r) => ({
        raw: r.raw,
        correct: r.expected,
        suggestion: r.topSuggestion,
        suggestionIsWrong: r.topSuggestionWrong,
      })),
    namesWithoutTruthEntry: missingTruth,
  });
}

// --- 4b. clubs of the other leagues: any resolution to a catalogue team is suspicious -----------
const otherResolved: Array<Record<string, unknown>> = [];
let otherClubCount = 0;
for (const file of OTHER_FILES) {
  for (const season of ['2025-26', '2026-27']) {
    let names: string[];
    try {
      const of = readOfMatches(join(dir, 'of', season, `${file}.json`));
      names = [...new Set(of.matches.flatMap((m) => [m.team1, m.team2]))];
    } catch {
      continue;
    }
    otherClubCount += names.length;
    for (const raw of names) {
      const r = resolve(raw);
      if (r.status !== 'unknown')
        otherResolved.push({ file, season, raw, outcome: outcomeOf(r), team: shortOf(idOf(r)) });
    }
  }
}

// --- 4c. probes: real-world spellings --------------------------------------------------------
const probes = PROBES.map((p) => {
  const r = resolve(p.raw);
  const got = shortOf(idOf(r));
  return {
    raw: p.raw,
    normalised: normalizeName(p.raw),
    expect: p.expect,
    got,
    outcome: outcomeOf(r),
    verdict:
      got === null
        ? p.expect === null
          ? 'ok (unresolved, correct)'
          : 'safe miss (needs alias)'
        : got === p.expect
          ? 'ok'
          : 'WRONG MATCH',
  };
});

// --- 4d. systematic collision test over all football catalogue teams ------------------------------
interface Form {
  team: string;
  raw: string;
  norm: string;
}
const forms: Form[] = teams.flatMap((t) =>
  [...new Set<string>([...(Object.values(t.name) as string[]), t.shortName])].map((raw) => ({
    team: teamId(t),
    raw,
    norm: normalizeName(raw),
  })),
);
const byNorm = new Map<string, Set<string>>();
for (const f of forms) byNorm.set(f.norm, new Set([...(byNorm.get(f.norm) ?? []), f.team]));
const exactCollisions = [...byNorm]
  .filter(([, s]) => s.size > 1)
  .map(([norm, s]) => ({ norm, teams: [...s] }));

// Mechanical variants real sources produce; each must resolve to the same team or to nothing.
const variantOf = (raw: string): string[] => {
  const noAccent = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [
    raw.toUpperCase(),
    raw.toLowerCase(),
    noAccent,
    raw.replace(/&/g, 'and'),
    raw.replace(/'/g, ''),
    `FC ${raw}`,
    `${raw} FC`,
    `${raw} CF`,
    `AFC ${raw}`,
    `${raw} SC`,
    `${raw} BSC`,
    raw.replace(/\./g, ''),
    raw.replace(/\s+/g, '  '),
  ];
};
let variantsTried = 0;
const variantWrong: Array<Record<string, unknown>> = [];
for (const f of forms) {
  for (const v of variantOf(f.raw)) {
    variantsTried += 1;
    const r = resolve(v);
    if (r.status === 'resolved' && r.id !== f.team) {
      variantWrong.push({ team: f.team, form: f.raw, variant: v, resolvedTo: r.id });
    } else if (r.status === 'ambiguous') {
      variantWrong.push({
        team: f.team,
        form: f.raw,
        variant: v,
        resolvedTo: `ambiguous:${r.ids.join(',')}`,
      });
    }
  }
}

// Hazards of rules the pipeline does NOT have (prefix/subset/typo matching): which real pairs they would merge.
const uniqueForms = [...new Map(forms.map((f) => [`${f.team}|${f.norm}`, f])).values()];
const hazard = {
  tokenSubset: [] as string[],
  firstToken: new Set<string>(),
  editDistance2: [] as string[],
};
const firstTokenGroups = new Map<string, Set<string>>();
for (const f of uniqueForms) {
  const first = nameTokens(f.norm)[0] ?? '';
  if (first.length >= 3)
    firstTokenGroups.set(first, new Set([...(firstTokenGroups.get(first) ?? []), f.team]));
}
for (const [tok, set] of firstTokenGroups)
  if (set.size > 1) hazard.firstToken.add(`${tok}: ${[...set].map(shortOf).join(' / ')}`);
for (let i = 0; i < uniqueForms.length; i += 1) {
  for (let j = i + 1; j < uniqueForms.length; j += 1) {
    const a = uniqueForms[i] as Form;
    const b = uniqueForms[j] as Form;
    if (a.team === b.team) continue;
    const ta = nameTokens(a.norm);
    const tb = nameTokens(b.norm);
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (
      small.length >= 1 &&
      small.every((t) => big.includes(t)) &&
      small.join(' ') !== big.join(' ')
    ) {
      hazard.tokenSubset.push(`"${a.raw}" (${shortOf(a.team)}) ~ "${b.raw}" (${shortOf(b.team)})`);
    }
    if (
      a.norm !== b.norm &&
      Math.abs(a.norm.length - b.norm.length) <= 2 &&
      levenshtein(a.norm, b.norm) <= 2
    ) {
      hazard.editDistance2.push(
        `"${a.raw}" (${shortOf(a.team)}) ~ "${b.raw}" (${shortOf(b.team)})`,
      );
    }
  }
}

// The shipped Costa Rica alias file imports with an empty source (= every source): what does that do?
const crCsv = parseCsv(
  readFileSync(
    new URL('../../../../docs/scraper-plan/data/costa-rica-aliases.csv', import.meta.url),
    'utf8',
  ),
).filter((r) => r['kind'] === 'team');
const byShort = new Map(teams.map((t) => [t.shortName, teamId(t)]));
const crIndex = catalogueIndex(
  crCsv.flatMap((r) => {
    const target = byShort.get(r['target'] ?? '');
    return target === undefined
      ? []
      : [
          {
            aliasNorm: normalizeName(r['alias'] ?? ''),
            sourceId: r['source'] === '' || r['source'] === '*' ? null : (r['source'] ?? null),
            teamId: target,
          },
        ];
  }),
);
const crGlobal = crCsv
  .filter((r) => r['source'] === '' || r['source'] === '*')
  .map((r) => {
    const alias = r['alias'] ?? '';
    const other = resolve(alias, index);
    return { alias, target: r['target'], resolvedWithoutFile: shortOf(idOf(other)) };
  });
const crProbe = [
  'Sporting',
  'Sporting CP',
  'Sporting Clube de Portugal',
  'Sporting F.C.',
  'Inter de San Carlos',
].map((raw) => ({
  raw,
  withAliasFile: shortOf(idOf(resolve(raw, crIndex))),
}));

// --- 5. coverage of the next 21 days ---------------------------------------------------------------
const DAY = 86_400_000;
const coverage: Array<Record<string, unknown>> = [];
for (const spec of SEEDED) {
  const url = ofUrl('2026-27', spec.file);
  const of = readOfMatches(join(dir, 'of', '2026-27', `${spec.file}.json`));
  const adapter = buildAdapter(envelope, url, spec.label, spec.zone);
  const outcome = parseDocument(adapter, url, of.body, now);
  const compOk = (label: string): boolean =>
    resolveCompetition(index, { sportId: 'football', sourceId: SOURCE_ID, raw: label }).status ===
    'resolved';
  for (const [horizonName, horizon] of [
    ['14d (FIXTURE_HORIZON_MS)', 14 * DAY],
    ['21d', 21 * DAY],
  ] as const) {
    const lo = now.getTime() + 10 * 60_000;
    const hi = now.getTime() + horizon;
    // Fixtures the file lists in the window by DATE (local date, midday UTC proxy): records with no time included.
    const listed = of.matches.filter((m) => {
      const t = Date.parse(`${m.date}T12:00:00Z`);
      return t > lo - 12 * 3_600_000 && t <= hi + 12 * 3_600_000;
    });
    const noTime = listed.filter((m) => m.time === undefined);
    const fx = outcome.fixtures.filter(
      (f) => f.kickoff.getTime() > lo && f.kickoff.getTime() <= hi,
    );
    const resolved = fx.filter(
      (f) => resolve(f.home).status === 'resolved' && resolve(f.away).status === 'resolved',
    );
    const blockers = countBy(
      fx.flatMap((f) => [f.home, f.away]).filter((n) => resolve(n).status !== 'resolved'),
      (n) => n,
    );
    coverage.push({
      league: spec.file,
      competitionLabelUsed: spec.label,
      competitionLabelResolves: compOk(spec.label),
      window: horizonName,
      listedInFileByDate: listed.length,
      droppedForMissingTime: noTime.length,
      adapterFixtures: fx.length,
      bothClubsResolve: resolved.length,
      wouldBecomeEvents: compOk(spec.label) ? resolved.length : 0,
      shareOfListedFixtures: pct(compOk(spec.label) ? resolved.length : 0, listed.length),
      shareOfAdapterFixtures: pct(resolved.length, fx.length),
      blockedByClub: blockers,
    });
  }
}
const premierDocumentedLabel = {
  label: 'English Premier League',
  resolvesWithoutCompetitionAlias: resolveCompetition(index, {
    sportId: 'football',
    sourceId: SOURCE_ID,
    raw: 'English Premier League',
  }).status,
  fileNames: {
    'es.1': 'Spain Primera División 2026/27',
    'de.1': 'Deutsche Bundesliga 2026/27',
    'it.1': 'Italian Serie A 2026/27',
    'fr.1': 'French Ligue 1 2026/27',
  },
  fileNamesResolve: [
    'English Premier League 2026/27',
    'Spain Primera División 2026/27',
    'Deutsche Bundesliga 2026/27',
    'Italian Serie A 2026/27',
    'French Ligue 1 2026/27',
  ].map((n) => ({
    n,
    status: resolveCompetition(index, { sportId: 'football', sourceId: SOURCE_ID, raw: n }).status,
  })),
};

const result = {
  asOf: now.toISOString(),
  catalogue: {
    footballTeams: teams.length,
    nameForms: forms.length,
    distinctNormalisedForms: byNorm.size,
  },
  leagues: leagueReports,
  wrongMatches,
  sameTargetCollisionsAmongSourceNames: sameTargetCollisions,
  otherLeagues: { clubsChecked: otherClubCount, resolvedToACatalogueTeam: otherResolved },
  probes,
  probeWrong: probes.filter((p) => p.verdict === 'WRONG MATCH').length,
  collisionTest: {
    teams: teams.length,
    nameForms: forms.length,
    exactNormalisedCollisions: exactCollisions,
    mechanicalVariantsTried: variantsTried,
    variantsResolvingToAnotherTeam: variantWrong,
    hazardsOfRulesThePipelineDoesNotHave: {
      firstTokenShared: [...hazard.firstToken],
      tokenSubsetPairs: hazard.tokenSubset,
      editDistanceAtMost2: hazard.editDistance2,
    },
  },
  costaRicaAliasFile: {
    teamRows: crCsv.length,
    rowsWithEmptySource: crGlobal.length,
    probes: crProbe,
  },
  coverage,
  competitionNames: premierDocumentedLabel,
};
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
process.stdout.write(`${`wrote ${out}`}\n`);
