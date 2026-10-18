/** One page of a cursor-paged admin list. */
export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedState<T> {
  items: T[];
  /** The next page's cursor; null when there is none (or before the first page). */
  cursor: string | null;
  error: string | null;
  loading: boolean;
}

export const INITIAL_PAGED_STATE: PagedState<never> = {
  items: [],
  cursor: null,
  error: null,
  loading: true,
};

export type FetchPage<T> = (cursor: string | null, signal: AbortSignal) => Promise<PageOf<T>>;
export type UpdatePaged<T> = (update: (state: PagedState<T>) => PagedState<T>) => void;

/**
 * The pages of one query (one loader per path and query: make a new one when
 * either changes, and dispose of the old one). Every request it makes is
 * aborted by `dispose`, and nothing a disposed loader receives reaches the
 * state, so a page of an old query is never appended to a new one. A failed
 * page can be asked for again.
 */
export class PagedLoader<T> {
  private readonly controllers = new Set<AbortController>();
  private cursor: string | null = null;
  private loadingMore = false;
  private disposed = false;

  constructor(
    private readonly fetchPage: FetchPage<T>,
    private readonly update: UpdatePaged<T>,
    private readonly describeError: (error: unknown) => string,
  ) {}

  /** Loads the first page (its items replace the list's). */
  start(): void {
    this.load(null);
  }

  /** Appends the next page, unless there is none or it is loading already. */
  loadMore(): void {
    if (this.disposed || this.cursor === null || this.loadingMore) return;
    this.loadingMore = true;
    this.load(this.cursor);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private load(after: string | null): void {
    const controller = new AbortController();
    this.controllers.add(controller);
    const live = () => !this.disposed && !controller.signal.aborted;
    this.update((state) => ({ ...state, loading: true }));
    this.fetchPage(after, controller.signal)
      .then(
        (page) => {
          if (!live()) return;
          this.cursor = page.nextCursor;
          this.update((state) => ({
            ...state,
            items: after === null ? page.items : [...state.items, ...page.items],
            cursor: page.nextCursor,
            error: null,
          }));
        },
        (error: unknown) => {
          if (live()) this.update((state) => ({ ...state, error: this.describeError(error) }));
        },
      )
      .finally(() => {
        this.controllers.delete(controller);
        if (after !== null) this.loadingMore = false;
        if (live() && this.controllers.size === 0) {
          this.update((state) => ({ ...state, loading: false }));
        }
      });
  }
}
