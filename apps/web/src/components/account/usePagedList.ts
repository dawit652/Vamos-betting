'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { appendPage } from './wallet';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedList<T> {
  items: T[];
  /** First page in flight (nothing shown yet). */
  loading: boolean;
  /** "Load more" in flight. */
  loadingMore: boolean;
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  /** Reloads from the first page (e.g. after a top-up). */
  reload: () => void;
}

/**
 * A cursor-paged list fetched in the browser. `fetchPage` must be stable
 * (useCallback) or the list reloads on every render.
 */
export function usePagedList<T extends { id: string }>(
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  // The "load more" request in flight; a reload (or unmount) drops it.
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    // A "load more" of the old list must not append to the new one, and its
    // spinner must not outlive it (its handlers return early once aborted).
    moreController.current?.abort();
    moreController.current = null;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    fetchPage(null, abort.signal).then(
      (page) => {
        if (abort.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => abort.abort();
  }, [fetchPage, generation]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    const abort = new AbortController();
    moreController.current = abort;
    setLoadingMore(true);
    setError(null);
    fetchPage(cursor, abort.signal).then(
      (page) => {
        if (abort.signal.aborted) return;
        setItems((current) => appendPage(current, page.items));
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setError(err);
        setLoadingMore(false);
      },
    );
  }, [cursor, fetchPage, loadingMore]);

  // A "load more" still in flight is dropped when the list goes away.
  useEffect(() => () => moreController.current?.abort(), []);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { items, loading, loadingMore, error, hasMore: cursor !== null, loadMore, reload };
}
