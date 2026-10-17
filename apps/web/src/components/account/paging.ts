import type { Page } from './usePagedList';
import { appendPage } from './wallet';

/**
 * Fetches the first `pages` pages of a cursor-paged list again (fewer when
 * the list ends sooner, at least one), as one list with the cursor after it:
 * what a silent refresh shows in place of the pages loaded so far. Items that
 * left the list meanwhile (a bet settled while the tab was hidden) are gone
 * from it; new ones are in. Rejects when `signal` is aborted.
 */
export async function refetchPages<T extends { id: string }>(
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  pages: number,
  signal: AbortSignal,
): Promise<{ items: T[]; nextCursor: string | null; pages: number }> {
  let items: T[] = [];
  let cursor: string | null = null;
  let fetched = 0;
  do {
    signal.throwIfAborted();
    const page = await fetchPage(cursor, signal);
    signal.throwIfAborted();
    items = appendPage(items, page.items);
    cursor = page.nextCursor;
    fetched += 1;
  } while (fetched < pages && cursor !== null);
  return { items, nextCursor: cursor, pages: fetched };
}
