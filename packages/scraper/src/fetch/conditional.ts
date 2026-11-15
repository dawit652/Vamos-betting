/** Conditional-request validators (docs/scraper.md 6.6): ETag and Last-Modified per URL. */

export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

/** Sync or async, so a database-backed store fits. Keyed by the URL the validators came from. */
export interface ConditionalStore {
  get(url: string): Validators | null | undefined | Promise<Validators | null | undefined>;
  /** Storing two nulls forgets the URL. */
  set(url: string, validators: Validators): void | Promise<void>;
}

export class InMemoryConditionalStore implements ConditionalStore {
  readonly #map = new Map<string, Validators>();

  get(url: string): Validators | undefined {
    return this.#map.get(url);
  }

  set(url: string, validators: Validators): void {
    if (validators.etag === null && validators.lastModified === null) this.#map.delete(url);
    else this.#map.set(url, { ...validators });
  }
}
