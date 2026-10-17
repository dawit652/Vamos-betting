import type { EventSourceLike, SseEnvironment, VisibilityTarget } from './resilient';

/**
 * Test doubles for the SSE clients (unit tests only; nothing in the app
 * imports this): an EventSource the test drives by hand and a document whose
 * visibility it sets. Use with vi.useFakeTimers().
 */

export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  private readonly handlers = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(
    readonly url: string,
    readonly withCredentials: boolean,
  ) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The connection is established (onopen). */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** A network error the browser retries by itself (CONNECTING), or a refusal (CLOSED). */
  fail(how: 'retrying' | 'closed'): void {
    this.readyState = how === 'retrying' ? 0 : 2;
    this.onerror?.(new Event('error'));
  }

  /** A named event arrives. */
  emit(type: string, data = '{}'): void {
    for (const listener of this.handlers.get(type) ?? []) {
      listener({ type, data } as MessageEvent<string>);
    }
  }

  /** Event types something listens to. */
  get listenedTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

export class FakeDocument implements VisibilityTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<() => void>();

  addEventListener(type: 'visibilitychange', listener: () => void): void {
    if (type === 'visibilitychange') this.listeners.add(listener);
  }

  removeEventListener(type: 'visibilitychange', listener: () => void): void {
    if (type === 'visibilitychange') this.listeners.delete(listener);
  }

  /** How many visibility listeners are bound. */
  get bound(): number {
    return this.listeners.size;
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface FakeSse {
  env: SseEnvironment;
  document: FakeDocument;
  /** Every source opened, oldest first. */
  sources: FakeEventSource[];
  /** The newest source. */
  last(): FakeEventSource;
  /** Sources not closed. */
  open(): FakeEventSource[];
}

export function fakeSse(): FakeSse {
  const document = new FakeDocument();
  const sources: FakeEventSource[] = [];
  return {
    env: {
      document,
      createSource: (url, withCredentials) => {
        const source = new FakeEventSource(url, withCredentials);
        sources.push(source);
        return source;
      },
    },
    document,
    sources,
    last: () => {
      const source = sources.at(-1);
      if (source === undefined) throw new Error('no EventSource was opened');
      return source;
    },
    open: () => sources.filter((source) => !source.closed),
  };
}
