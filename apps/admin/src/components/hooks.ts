'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Query } from '@/lib/config';
import { describeError } from '@/lib/errors';
import { INITIAL_PAGED_STATE, PagedLoader, type PageOf, type PagedState } from '@/lib/paging';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** GET `path` with `query`; reloads when either changes. */
export function useFetch<T>(path: string | null, query?: Query): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setLoading(true);
    api<T>(path, { query: JSON.parse(queryKey) as Query, signal: controller.signal })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(describeError(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, queryKey, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

export interface Paged<T> {
  items: T[];
  error: string | null;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * A cursor-paged list: the first page loads on mount and on query change, `loadMore` appends.
 * One PagedLoader per query: a change aborts the old query's requests (a Load more included).
 */
export function usePaged<T>(path: string, query?: Query): Paged<T> {
  const [state, setState] = useState<PagedState<T>>(INITIAL_PAGED_STATE);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query ?? {});
  const loader = useRef<PagedLoader<T> | null>(null);

  useEffect(() => {
    const base = JSON.parse(queryKey) as Query;
    const current = new PagedLoader<T>(
      (cursor, signal) => api<PageOf<T>>(path, { query: { ...base, cursor }, signal }),
      setState,
      describeError,
    );
    loader.current = current;
    current.start();
    return () => current.dispose();
  }, [path, queryKey, tick]);

  const loadMore = useCallback(() => loader.current?.loadMore(), []);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return {
    items: state.items,
    error: state.error,
    loading: state.loading,
    hasMore: state.cursor !== null,
    loadMore,
    reload,
  };
}
