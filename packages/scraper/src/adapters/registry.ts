import type { ScrapeAdapterName } from '@vamos/core';
import type { z } from 'zod';
import type { SourceAdapter, SourceDescriptor, SourceKind } from '../types';
import { zodErrors } from './common';
import { createGenericHtmlAdapter, GenericHtmlConfigSchema } from './generic-html';
import { createGenericJsonAdapter, GenericJsonConfigSchema } from './generic-json';
import { createOpenFootballAdapter, OpenFootballConfigSchema } from './openfootball';

export interface SourceRow {
  id: string;
  adapter: ScrapeAdapterName;
  upstream: string;
  config: unknown;
}

export type CreateAdapterResult =
  { ok: true; adapter: SourceAdapter } | { ok: false; errors: string[] };

function build<C>(
  schema: z.ZodType<C>,
  row: SourceRow,
  kind: SourceKind,
  make: (d: SourceDescriptor, c: C) => SourceAdapter,
): CreateAdapterResult {
  const parsed = schema.safeParse(row.config);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  return { ok: true, adapter: make({ id: row.id, upstream: row.upstream, kind }, parsed.data) };
}

/**
 * Builds the adapter a source row names, from its validated config. Never
 * throws: a bad row or config comes back as `errors` (the source then stays
 * disabled). Every config needs an `allowedHosts` list that covers all its
 * https request URLs (rule S3).
 */
export function createAdapter(row: SourceRow): CreateAdapterResult {
  try {
    if (typeof row.id !== 'string' || row.id.trim() === '' || row.id.length > 64) {
      return { ok: false, errors: ['id: must be 1 to 64 characters'] };
    }
    if (typeof row.upstream !== 'string' || row.upstream.trim() === '') {
      return { ok: false, errors: ['upstream: must not be empty'] };
    }
    switch (row.adapter) {
      case 'openfootball':
        return build(OpenFootballConfigSchema, row, 'json_api', createOpenFootballAdapter);
      case 'generic-json':
        return build(GenericJsonConfigSchema, row, 'json_api', createGenericJsonAdapter);
      case 'generic-html':
        return build(GenericHtmlConfigSchema, row, 'html', createGenericHtmlAdapter);
      default:
        return { ok: false, errors: [`adapter: unknown adapter "${String(row.adapter)}"`] };
    }
  } catch (error) {
    return { ok: false, errors: [`config: ${error instanceof Error ? error.message : 'invalid'}`] };
  }
}
