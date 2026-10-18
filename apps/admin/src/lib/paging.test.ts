import { describe, expect, it } from 'vitest';
import { INITIAL_PAGED_STATE, PagedLoader, type PageOf, type PagedState } from './paging';

interface Call {
  cursor: string | null;
  signal: AbortSignal;
  resolve: (page: PageOf<string>) => void;
  reject: (error: unknown) => void;
}

/** A fake API whose responses the test resolves by hand, in any order. */
function harness() {
  const calls: Call[] = [];
  let state: PagedState<string> = INITIAL_PAGED_STATE;
  const fetchPage = (cursor: string | null, signal: AbortSignal) =>
    new Promise<PageOf<string>>((resolve, reject) => {
      calls.push({ cursor, signal, resolve, reject });
    });
  const update = (fn: (s: PagedState<string>) => PagedState<string>) => {
    state = fn(state);
  };
  const loader = () =>
    new PagedLoader<string>(fetchPage, update, (e) => (e instanceof Error ? e.message : 'error'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, loader, settle, state: () => state };
}

describe('PagedLoader', () => {
  it('loads the first page, then appends the next one', async () => {
    const h = harness();
    const pager = h.loader();
    pager.start();
    h.calls[0]!.resolve({ items: ['a'], nextCursor: 'c1' });
    await h.settle();
    expect(h.state()).toMatchObject({ items: ['a'], cursor: 'c1', loading: false, error: null });
    pager.loadMore();
    pager.loadMore(); // a second click while the page loads asks for nothing more
    expect(h.calls.map((c) => c.cursor)).toEqual([null, 'c1']);
    h.calls[1]!.resolve({ items: ['b'], nextCursor: null });
    await h.settle();
    expect(h.state()).toMatchObject({ items: ['a', 'b'], cursor: null, loading: false });
  });

  it('lets Load more retry the same page after it failed', async () => {
    const h = harness();
    const pager = h.loader();
    pager.start();
    h.calls[0]!.resolve({ items: ['a'], nextCursor: 'c1' });
    await h.settle();
    pager.loadMore();
    h.calls[1]!.reject(new TypeError('Failed to fetch'));
    await h.settle();
    expect(h.state()).toMatchObject({ error: 'Failed to fetch', cursor: 'c1', loading: false });
    pager.loadMore();
    expect(h.calls.map((c) => c.cursor)).toEqual([null, 'c1', 'c1']);
    h.calls[2]!.resolve({ items: ['b'], nextCursor: null });
    await h.settle();
    expect(h.state()).toMatchObject({ items: ['a', 'b'], error: null, cursor: null });
  });

  it('drops a Load more of the previous query when the query changes', async () => {
    const h = harness();
    const old = h.loader();
    old.start();
    h.calls[0]!.resolve({ items: ['old-1'], nextCursor: 'c1' });
    await h.settle();
    old.loadMore(); // request #2, still loading when the filter changes
    old.dispose();
    expect(h.calls[1]!.signal.aborted).toBe(true);
    const next = h.loader();
    next.start(); // request #3
    h.calls[2]!.resolve({ items: ['new-1'], nextCursor: null });
    await h.settle();
    // The stale page arrives last: ignored.
    h.calls[1]!.resolve({ items: ['old-2'], nextCursor: 'c2' });
    await h.settle();
    expect(h.state()).toMatchObject({ items: ['new-1'], cursor: null, loading: false });
    next.loadMore();
    expect(h.calls).toHaveLength(3);
  });
});
