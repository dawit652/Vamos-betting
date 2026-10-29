import { getSource, listSources, sourceHealth, upsertSource } from '@vamos/db';
import {
  EXIT_OK,
  emit,
  noPositionals,
  parseCommandArgs,
  requiredString,
  table,
  type CliEnv,
} from './io';
import { loadSourceFile } from './source-file';

const iso = (date: Date | null): string => (date === null ? '-' : date.toISOString());

/** `sources list`: every source with its state (enabled, last run, failures, open review items). */
export async function sourcesList(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db = await env.database();
  const [sources, health] = await Promise.all([listSources(db), sourceHealth(db, env.clock())]);
  const byId = new Map(health.map((h) => [h.sourceId, h]));
  const rows = sources.map((source) => {
    const h = byId.get(source.id);
    return {
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      upstream: source.upstream,
      enabled: source.enabled,
      lastStatus: h?.lastStatus ?? null,
      lastOkAt: h?.lastOkAt ?? null,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      openReviewItems: h?.openReviewItems ?? 0,
    };
  });
  const lines =
    rows.length === 0
      ? ['no sources']
      : table(
          ['id', 'adapter', 'upstream', 'state', 'last run', 'last ok', 'failures', 'open items'],
          rows.map((r) => [
            r.id,
            r.adapter,
            r.upstream,
            r.enabled ? 'enabled' : 'disabled',
            r.lastStatus ?? 'never run',
            iso(r.lastOkAt),
            String(r.consecutiveFailures),
            String(r.openReviewItems),
          ]),
        );
  emit(env, parsed, rows, lines);
  return EXIT_OK;
}

/**
 * `sources upsert --file source.json`: validates the config with createAdapter,
 * then upserts. A new source starts DISABLED and an existing one keeps its
 * enabled flag: switching a source on stays a person's decision.
 */
export async function sourcesUpsert(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { file: { type: 'string' } });
  noPositionals(parsed);
  const { source } = await loadSourceFile(env, requiredString(parsed, 'file'));
  const db = await env.database();
  const before = await getSource(db, source.id);
  const saved = await db.transaction((tx) => upsertSource(tx, source, env.actor));
  const outcome =
    before === null
      ? 'created'
      : saved.updatedAt.getTime() === before.updatedAt.getTime()
        ? 'unchanged'
        : 'updated';
  emit(env, parsed, { outcome, id: saved.id, enabled: saved.enabled, adapter: saved.adapter }, [
    `${outcome} source ${saved.id} (${saved.adapter}, upstream ${saved.upstream})`,
    saved.enabled
      ? 'state: enabled (unchanged)'
      : 'state: disabled; it stays off until a person switches it on',
  ]);
  return EXIT_OK;
}
