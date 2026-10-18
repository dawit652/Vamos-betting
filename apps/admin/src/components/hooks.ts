'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Query } from '@/lib/config';
import { describeError } from '@/lib/errors';

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

interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Paged<T> {
  items: T[];
  error: string | null;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/** A cursor-paged list: the first page loads on mount and on query change, `loadMore` appends. */
export function usePaged<T>(path: string, query?: Query): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const queryKey = JSON.stringify(query ?? {});
  const pending = useRef<string | null>(null);

  const fetchPage = useCallback(
    (after: string | null, signal: AbortSignal) => {
      setLoading(true);
      const q = { ...(JSON.parse(queryKey) as Query), cursor: after };
      api<PageOf<T>>(path, { query: q, signal })
        .then((page) => {
          setItems((old) => (after === null ? page.items : [...old, ...page.items]));
          setCursor(page.nextCursor);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!signal.aborted) setError(describeError(e));
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    },
    [path, queryKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    pending.current = null;
    fetchPage(null, controller.signal);
    return () => controller.abort();
  }, [fetchPage, tick]);

  const loadMore = useCallback(() => {
    if (cursor === null || pending.current === cursor) return;
    pending.current = cursor;
    fetchPage(cursor, new AbortController().signal);
  }, [cursor, fetchPage]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, error, loading, hasMore: cursor !== null, loadMore, reload };
}
