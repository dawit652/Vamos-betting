'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { refetchPages } from './paging';
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
  /** Reloads from the first page (e.g. after a top-up), showing the loading state. */
  reload: () => void;
  /**
   * Fetches the pages loaded so far again in the background and swaps them in
   * (e.g. after a push stream resync): no loading state, the items keep their
   * place (and their components their state), and loaded pages stay loaded.
   * On failure the list keeps what it shows.
   */
  refresh: () => void;
  /** Replaces the loaded items (live patches such as a settled bet or a fresh cash-out offer). */
  setItems: (update: (items: T[]) => T[]) => void;
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
  // The silent refresh in flight; a reload, another refresh (or unmount) drops it.
  const refreshController = useRef<AbortController | null>(null);
  // Pages shown (what a refresh fetches again), and whether the first is still loading.
  const pagesLoaded = useRef(0);
  const firstLoading = useRef(true);

  useEffect(() => {
    const abort = new AbortController();
    // A "load more" of the old list must not append to the new one, and its
    // spinner must not outlive it (its handlers return early once aborted).
    moreController.current?.abort();
    moreController.current = null;
    refreshController.current?.abort();
    refreshController.current = null;
    pagesLoaded.current = 0;
    firstLoading.current = true;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    fetchPage(null, abort.signal).then(
      (page) => {
        if (abort.signal.aborted) return;
        pagesLoaded.current = 1;
        firstLoading.current = false;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        firstLoading.current = false;
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
        pagesLoaded.current += 1;
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

  // Requests still in flight are dropped when the list goes away.
  useEffect(
    () => () => {
      moreController.current?.abort();
      refreshController.current?.abort();
    },
    [],
  );

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  const refresh = useCallback(() => {
    // The first load in flight brings fresh items anyway.
    if (firstLoading.current) return;
    refreshController.current?.abort();
    const abort = new AbortController();
    refreshController.current = abort;
    // A "load more" in flight is folded into the refresh (one more page).
    const more = moreController.current !== null && !moreController.current.signal.aborted;
    moreController.current?.abort();
    moreController.current = null;
    setLoadingMore(false);
    refetchPages(fetchPage, pagesLoaded.current + (more ? 1 : 0), abort.signal).then(
      (fresh) => {
        if (abort.signal.aborted) return;
        refreshController.current = null;
        pagesLoaded.current = fresh.pages;
        setItems(fresh.items);
        setCursor(fresh.nextCursor);
        setError(null);
      },
      () => {
        // Keep what is shown; the next resync or message tries again.
        if (refreshController.current === abort) refreshController.current = null;
      },
    );
  }, [fetchPage]);

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore: cursor !== null,
    loadMore,
    reload,
    refresh,
    setItems,
  };
}
