import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

/**
 * The raw archive (docs/scraper.md section 1): the exact bytes of every fetched
 * document, so a parse can be replayed and a settlement can be traced to the
 * page that justified it. Content-addressed by SHA-256.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const ARCHIVE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Anything that is not 64 lower-case hex characters. Thrown instead of building a path from it. */
export class InvalidArchiveHashError extends Error {
  constructor() {
    super('archive hash must be 64 lower-case hex characters');
    this.name = 'InvalidArchiveHashError';
  }
}

/** The stored bytes no longer match their hash (or are not valid gzip). Evidence must not be trusted. */
export class ArchiveCorruptError extends Error {
  readonly hash: string;
  readonly reason: 'gzip' | 'hash_mismatch';
  constructor(hash: string, reason: 'gzip' | 'hash_mismatch') {
    super(`archive entry ${hash} is corrupt (${reason})`);
    this.name = 'ArchiveCorruptError';
    this.hash = hash;
    this.reason = reason;
  }
}

export interface ArchiveMeta {
  /** When the document was fetched; becomes the entry's age for pruning. Defaults to now. */
  fetchedAt?: Date;
}

export interface PutResult {
  hash: string;
  /** Length of the original (uncompressed) bytes. */
  bytes: number;
  /** True when this call wrote the entry; false when identical bytes were already there. */
  stored: boolean;
}

export interface PruneInput {
  /** Entries last stored before this instant may be removed... */
  olderThan: Date;
  /** ...unless their hash is in here (result evidence is never pruned). */
  keep: ReadonlySet<string>;
}

export interface RawArchive {
  put(bytes: Uint8Array, meta?: ArchiveMeta): Promise<PutResult>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  prune(input: PruneInput): Promise<{ removed: number; kept: number }>;
}

export interface FileRawArchiveOptions {
  now?: () => Date;
  /** Largest document accepted or read back. Default 64 MiB. */
  maxBytes?: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertHash(hash: string): void {
  if (typeof hash !== 'string' || !ARCHIVE_HASH_PATTERN.test(hash))
    throw new InvalidArchiveHashError();
}

const TEMP_SUFFIX = '.tmp';
const TEMP_PATTERN = /^\.[0-9a-f]{64}\.[0-9a-f]{16}\.tmp$/;
const ENTRY_PATTERN = /^([0-9a-f]{64})\.gz$/;
/** A temp file younger than this may belong to a write in progress. */
const TEMP_GRACE_MS = 60 * 60_000;

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

/**
 * `<dir>/<hash[0..2]>/<hash[2..4]>/<hash>.gz`, gzip-compressed, written to a temp
 * file in the same directory, fsynced, and published atomically (a crash leaves
 * either nothing or the whole file). Directories 0700, files 0600. Identical
 * bytes are stored once.
 */
export class FileRawArchive implements RawArchive {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #maxBytes: number;

  constructor(dir: string, options: FileRawArchiveOptions = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('archive directory is required');
    this.#dir = dir;
    this.#now = options.now ?? (() => new Date());
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  #subdir(hash: string): string {
    return join(this.#dir, hash.slice(0, 2), hash.slice(2, 4));
  }

  #path(hash: string): string {
    return join(this.#subdir(hash), `${hash}.gz`);
  }

  async put(bytes: Uint8Array, meta: ArchiveMeta = {}): Promise<PutResult> {
    if (bytes.byteLength > this.#maxBytes)
      throw new RangeError('document exceeds the archive size limit');
    const hash = sha256Hex(bytes);
    const at = meta.fetchedAt ?? this.#now();
    const finalPath = this.#path(hash);

    if (await this.#exists(finalPath)) {
      if (await this.#isIntact(hash)) {
        await this.#touch(finalPath, at);
        return { hash, bytes: bytes.byteLength, stored: false };
      }
      // A damaged entry is replaced by the good bytes we hold.
      await this.#write(hash, bytes, at, true);
      return { hash, bytes: bytes.byteLength, stored: true };
    }
    const stored = await this.#write(hash, bytes, at, false);
    if (!stored) await this.#touch(finalPath, at);
    return { hash, bytes: bytes.byteLength, stored };
  }

  /** Returns false when another writer published identical bytes first. */
  async #write(hash: string, bytes: Uint8Array, at: Date, replace: boolean): Promise<boolean> {
    const compressed = await gzipAsync(bytes, { level: 6 });
    const dir = this.#subdir(hash);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${hash}.${randomBytes(8).toString('hex')}${TEMP_SUFFIX}`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(compressed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await utimes(temp, at, at);
      const finalPath = this.#path(hash);
      if (replace) {
        await rename(temp, finalPath);
        return true;
      }
      try {
        await link(temp, finalPath); // fails with EEXIST if somebody else got there first
      } catch (e) {
        if (code(e) === 'EEXIST') return false;
        await rename(temp, finalPath); // filesystem without hard links
        return true;
      }
      return true;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (e) {
      if (code(e) === 'ENOENT') return false;
      throw e;
    }
  }

  async #isIntact(hash: string): Promise<boolean> {
    try {
      return (await this.get(hash)) !== null;
    } catch (e) {
      if (e instanceof ArchiveCorruptError) return false;
      throw e;
    }
  }

  async #touch(path: string, at: Date): Promise<void> {
    try {
      const { mtime } = await stat(path);
      if (at.getTime() > mtime.getTime()) await utimes(path, at, at);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
    }
  }

  async has(hash: string): Promise<boolean> {
    assertHash(hash);
    return this.#exists(this.#path(hash));
  }

  async get(hash: string): Promise<Uint8Array | null> {
    assertHash(hash);
    let compressed: Buffer;
    try {
      compressed = await readFile(this.#path(hash));
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
    let bytes: Buffer;
    try {
      bytes = await gunzipAsync(compressed, { maxOutputLength: this.#maxBytes });
    } catch {
      throw new ArchiveCorruptError(hash, 'gzip');
    }
    if (sha256Hex(bytes) !== hash) throw new ArchiveCorruptError(hash, 'hash_mismatch');
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async prune({ olderThan, keep }: PruneInput): Promise<{ removed: number; kept: number }> {
    let removed = 0;
    let kept = 0;
    for (const a of await this.#children(this.#dir, /^[0-9a-f]{2}$/)) {
      for (const b of await this.#children(join(this.#dir, a), /^[0-9a-f]{2}$/)) {
        const dir = join(this.#dir, a, b);
        for (const name of await this.#files(dir)) {
          const m = ENTRY_PATTERN.exec(name);
          if (!m?.[1]) continue;
          const hash = m[1];
          if (!hash.startsWith(a + b)) continue; // misplaced file: not ours to judge
          const path = join(dir, name);
          let mtime: Date;
          try {
            mtime = (await stat(path)).mtime;
          } catch (e) {
            if (code(e) === 'ENOENT') continue;
            throw e;
          }
          if (mtime.getTime() < olderThan.getTime() && !keep.has(hash)) {
            await unlink(path).catch((e: unknown) => {
              if (code(e) !== 'ENOENT') throw e;
            });
            removed += 1;
          } else {
            kept += 1;
          }
        }
      }
    }
    await this.cleanTemp({ olderThan });
    return { removed, kept };
  }

  /**
   * Deletes temp files left by a crashed write. A temp file is removed only when
   * it is older than `olderThan` AND older than an hour (so a live write is safe).
   */
  async cleanTemp({ olderThan }: { olderThan: Date }): Promise<number> {
    const cutoff = Math.min(olderThan.getTime(), this.#now().getTime() - TEMP_GRACE_MS);
    let removed = 0;
    for (const a of await this.#children(this.#dir, /^[0-9a-f]{2}$/)) {
      for (const b of await this.#children(join(this.#dir, a), /^[0-9a-f]{2}$/)) {
        const dir = join(this.#dir, a, b);
        for (const name of await this.#files(dir)) {
          if (!TEMP_PATTERN.test(name)) continue;
          const path = join(dir, name);
          try {
            if ((await stat(path)).mtime.getTime() < cutoff) {
              await unlink(path);
              removed += 1;
            }
          } catch (e) {
            if (code(e) !== 'ENOENT') throw e;
          }
        }
      }
    }
    return removed;
  }

  /** Sub-directories whose name matches; symlinks are never followed. */
  async #children(dir: string, pattern: RegExp): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && pattern.test(e.name)).map((e) => e.name);
    } catch (e) {
      if (code(e) === 'ENOENT') return [];
      throw e;
    }
  }

  async #files(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (e) {
      if (code(e) === 'ENOENT') return [];
      throw e;
    }
  }
}
