import type { MapBatchItem, MapBatchResult, ReviewItemView } from '@vamos/contracts';
import { isTargetId } from './feed';

/**
 * Pure helpers for the "Unknown names" bulk-map page (plan U-5): open unknown_team items grouped
 * by spelling, the suggestion to pre-pick, and the batch requests a selection becomes.
 */

/** The API takes at most this many items per batch call (MAP_BATCH_MAX of @vamos/contracts). */
export const BATCH_SIZE = 50;

/** A suggestion at or above this similarity is shown as the strong one (plan U-4). */
export const STRONG_SUGGESTION = 0.6;

export interface GroupSuggestion {
  id: string;
  name: string;
  score: number;
}

export interface UnknownNameEntry {
  itemId: string;
  sourceId: string;
  competition: string;
  /** Fixture context the payload carries (opponent, kickoff), when it does. */
  context: string | null;
  createdAt: string;
}

export interface UnknownNameGroup {
  /** The normalised spelling: one row per key. */
  key: string;
  /** The spelling of the first item, as a source wrote it. */
  raw: string;
  entries: UnknownNameEntry[];
  sources: string[];
  competitions: string[];
  /** The suggestions of every item, best score per team, best first. */
  suggestions: GroupSuggestion[];
}

/** Case, accents, punctuation and spacing do not make a new spelling. */
export function spellingKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'\u2019]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function suggestionsOf(value: unknown): GroupSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: GroupSuggestion[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name, score } = entry as Record<string, unknown>;
    if (typeof id === 'string' && typeof name === 'string' && typeof score === 'number') {
      out.push({ id, name, score });
    }
  }
  return out;
}

/**
 * The fixture context of an unknown name, when the payload carries one under `fixture`
 * (`opponent`, `kickoff`, `competition`): "vs Fasil Kenema, 2026-11-14 16:00 UTC". Null otherwise.
 */
export function fixtureContext(payload: Record<string, unknown>): string | null {
  const fixture = payload.fixture;
  if (typeof fixture !== 'object' || fixture === null) return null;
  const f = fixture as Record<string, unknown>;
  const opponent = str(f.opponent);
  const kickoff = str(f.kickoff);
  const when =
    kickoff !== null && !Number.isNaN(Date.parse(kickoff))
      ? `${new Date(kickoff).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : null;
  const parts = [opponent === null ? null : `vs ${opponent}`, when].filter(
    (p): p is string => p !== null,
  );
  return parts.length === 0 ? null : parts.join(', ');
}

/** Open unknown_team items, one group per spelling (oldest group first, entries oldest first). */
export function groupUnknownNames(items: readonly ReviewItemView[]): UnknownNameGroup[] {
  const groups = new Map<string, UnknownNameGroup>();
  const best = new Map<string, Map<string, GroupSuggestion>>();
  const sorted = items
    .filter((i) => i.kind === 'unknown_team' && i.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    const raw = str(item.payload.raw);
    if (raw === null) continue;
    const key = spellingKey(raw);
    if (key === '') continue;
    const sourceId = str(item.payload.sourceId) ?? '';
    const competition = str(item.payload.competition) ?? '';
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, raw, entries: [], sources: [], competitions: [], suggestions: [] };
      groups.set(key, group);
      best.set(key, new Map());
    }
    group.entries.push({
      itemId: item.id,
      sourceId,
      competition,
      context: fixtureContext(item.payload),
      createdAt: item.createdAt,
    });
    if (sourceId !== '' && !group.sources.includes(sourceId)) group.sources.push(sourceId);
    if (competition !== '' && !group.competitions.includes(competition)) {
      group.competitions.push(competition);
    }
    const seen = best.get(key)!;
    for (const s of suggestionsOf(item.payload.suggestions)) {
      const have = seen.get(s.id);
      if (have === undefined || s.score > have.score) seen.set(s.id, s);
    }
  }
  for (const [key, group] of groups) {
    group.suggestions = [...best.get(key)!.values()].sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name),
    );
  }
  return [...groups.values()];
}

/** Groups whose spelling, source or competition contains the text (case and accents ignored). */
export function filterGroups(
  groups: readonly UnknownNameGroup[],
  text: string,
): UnknownNameGroup[] {
  const needle = spellingKey(text);
  if (needle === '') return [...groups];
  return groups.filter((g) =>
    [g.raw, ...g.sources, ...g.competitions].some((v) => spellingKey(v).includes(needle)),
  );
}

/** The suggestion to pre-pick: the best one, only when it is strong. */
export function strongSuggestion(
  group: Pick<UnknownNameGroup, 'suggestions'>,
): GroupSuggestion | null {
  const top = group.suggestions[0];
  return top !== undefined && top.score >= STRONG_SUGGESTION ? top : null;
}

/** The team a row maps to: a typed id wins over the picked suggestion; '' when neither is valid. */
export function pickedTarget(typed: string, picked: string): string {
  const t = typed.trim();
  if (t !== '') return isTargetId(t) ? t : '';
  return isTargetId(picked) ? picked.trim() : '';
}

export interface BatchPlan {
  items: MapBatchItem[];
  /** Selected groups left out because no valid team is chosen for them. */
  skipped: string[];
}

/**
 * The batch items of a selection: every open item of each selected spelling, mapped to the team
 * chosen for the row, with the page's scope. A selected row without a valid team is skipped.
 */
export function buildBatchItems(
  groups: readonly UnknownNameGroup[],
  selected: ReadonlySet<string>,
  targets: Readonly<Record<string, string>>,
  scope: MapBatchItem['scope'],
): BatchPlan {
  const items: MapBatchItem[] = [];
  const skipped: string[] = [];
  for (const group of groups) {
    if (!selected.has(group.key)) continue;
    const targetId = targets[group.key] ?? '';
    if (!isTargetId(targetId)) {
      skipped.push(group.raw);
      continue;
    }
    for (const entry of group.entries) items.push({ itemId: entry.itemId, targetId, scope });
  }
  return { items, skipped };
}

/** Splits items into API-sized batches. */
export function chunkBatch<T>(items: readonly T[], size: number = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "3 mapped, 1 failed" with the first failure reasons. */
export function batchSummary(results: readonly MapBatchResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const mapped = results.length - failed.length;
  const reasons = [...new Set(failed.map((r) => r.error?.message ?? 'failed'))].slice(0, 3);
  return failed.length === 0
    ? `${mapped} mapped.`
    : `${mapped} mapped, ${failed.length} failed: ${reasons.join('; ')}`;
}
