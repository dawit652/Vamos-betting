import type {
  JackpotEntryRequest,
  JackpotEntryView,
  JackpotListResponse,
  JackpotTemplateCode,
  MyJackpotEntriesResponse,
} from '@vamos/contracts';
import { api } from './client';

/** Browser calls of the jackpot screens. Types only from @vamos/contracts: no zod in the bundle. */

const PAGE_SIZE = 20;

export const jackpotsApi = {
  /** Open rounds and recent ones (public). */
  list: (template: JackpotTemplateCode, signal?: AbortSignal) =>
    api.get<JackpotListResponse>('/jackpots', {
      query: { template, limit: 5 },
      ...(signal ? { signal } : {}),
    }),

  /** Places an entry; reuse `idempotencyKey` for every retry of the same picks. */
  place: (roundId: string, body: JackpotEntryRequest, idempotencyKey: string) =>
    api.post<JackpotEntryView>(`/jackpots/${encodeURIComponent(roundId)}/entries`, body, {
      idempotencyKey,
    }),

  myEntries: (cursor: string | null, signal?: AbortSignal) =>
    api.get<MyJackpotEntriesResponse>('/me/jackpot-entries', {
      query: { limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) },
      ...(signal ? { signal } : {}),
    }),
};
