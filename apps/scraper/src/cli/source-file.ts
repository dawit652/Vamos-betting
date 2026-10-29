import { SCRAPE_ADAPTERS } from '@vamos/core';
import { createAdapter, type SourceAdapter } from '@vamos/scraper';
import { z } from 'zod';
import { CliFailure, parseJson, readInput, type CliEnv } from './io';

/** The shape of `source.json`: one row of scrape_sources, without `enabled`. */
export const SourceFileSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    adapter: z.enum(SCRAPE_ADAPTERS),
    upstream: z.string().trim().min(1).max(100),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SourceFile = z.infer<typeof SourceFileSchema>;

export interface LoadedSource {
  source: SourceFile;
  adapter: SourceAdapter;
}

/**
 * Reads and validates a source file: the envelope with zod, the config with
 * `createAdapter` (the same check the runner makes before every run, so a file
 * accepted here is never refused later). Every problem is listed.
 */
export async function loadSourceFile(env: CliEnv, path: string): Promise<LoadedSource> {
  const raw = parseJson(await readInput(env, path, 'source file'), `source file ${path}`);
  const parsed = SourceFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliFailure(
      `source file ${path} is not valid`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`),
    );
  }
  const source = parsed.data;
  const built = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  if (!built.ok) {
    throw new CliFailure(
      `the config of source "${source.id}" (${source.adapter}) is not valid`,
      built.errors,
    );
  }
  return { source, adapter: built.adapter };
}
