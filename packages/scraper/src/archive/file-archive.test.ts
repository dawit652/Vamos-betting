import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveCorruptError,
  FileRawArchive,
  InvalidArchiveHashError,
  sha256Hex,
} from './file-archive';

const enc = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
const T0 = new Date('2026-06-01T12:00:00Z');
const DAY = 86_400_000;

let dir: string;
let archive: FileRawArchive;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vamos-archive-'));
  clock = T0;
  archive = new FileRawArchive(join(dir, 'store'), { now: () => clock });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entryPath = (hash: string) =>
  join(dir, 'store', hash.slice(0, 2), hash.slice(2, 4), `${hash}.gz`);

async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out;
}

describe('FileRawArchive', () => {
  it('stores content-addressed gzip files and reads them back', async () => {
    const r = await archive.put(enc('hello world'));
    expect(r).toEqual({ hash: hashOf('hello world'), bytes: 11, stored: true });
    expect(r.hash).toBe(sha256Hex(enc('hello world')));
    expect(await archive.has(r.hash)).toBe(true);
    expect(new TextDecoder().decode((await archive.get(r.hash)) ?? new Uint8Array())).toBe(
      'hello world',
    );
    const raw = await readFile(entryPath(r.hash));
    expect(raw[0]).toBe(0x1f); // gzip magic
    expect(raw[1]).toBe(0x8b);
  });

  it('handles empty documents and binary bytes', async () => {
    const empty = await archive.put(new Uint8Array());
    expect(empty).toMatchObject({ bytes: 0, stored: true });
    expect((await archive.get(empty.hash))?.byteLength).toBe(0);
    const bin = Uint8Array.from([0, 255, 1, 254, 0]);
    expect(await archive.get((await archive.put(bin)).hash)).toEqual(bin);
  });

  it('returns null / false for unknown hashes', async () => {
    const h = hashOf('absent');
    expect(await archive.get(h)).toBeNull();
    expect(await archive.has(h)).toBe(false);
  });

  it('deduplicates identical bytes', async () => {
    const a = await archive.put(enc('same'));
    const b = await archive.put(enc('same'));
    expect(a.hash).toBe(b.hash);
    expect([a.stored, b.stored]).toEqual([true, false]);
    expect(await allFiles(join(dir, 'store'))).toHaveLength(1);
  });

  it('stores concurrent identical puts once, with exactly one writer reporting stored', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => archive.put(enc('race'))));
    expect(results.filter((r) => r.stored)).toHaveLength(1);
    expect(new Set(results.map((r) => r.hash)).size).toBe(1);
    expect(await allFiles(join(dir, 'store'))).toHaveLength(1);
    expect(await archive.get(results[0]?.hash ?? '')).not.toBeNull();
  });

  it('uses directories 0700 and files 0600', async () => {
    const { hash } = await archive.put(enc('perms'));
    expect((await stat(entryPath(hash))).mode & 0o777).toBe(0o600);
    for (const d of [
      join(dir, 'store'),
      join(dir, 'store', hash.slice(0, 2)),
      join(dir, 'store', hash.slice(0, 2), hash.slice(2, 4)),
    ]) {
      expect((await stat(d)).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves no temp files behind after a successful put', async () => {
    await archive.put(enc('tidy'));
    expect((await allFiles(join(dir, 'store'))).every((f) => f.endsWith('.gz'))).toBe(true);
  });

  it('detects corruption: bad gzip, and valid gzip of different bytes', async () => {
    const { hash } = await archive.put(enc('evidence'));
    await writeFile(entryPath(hash), Buffer.from('garbage'));
    await expect(archive.get(hash)).rejects.toMatchObject({
      name: 'ArchiveCorruptError',
      reason: 'gzip',
      hash,
    });
    await writeFile(entryPath(hash), gzipSync('tampered'));
    const err = await archive.get(hash).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveCorruptError);
    expect((err as ArchiveCorruptError).reason).toBe('hash_mismatch');
  });

  it('heals a damaged entry when the same bytes are put again', async () => {
    const { hash } = await archive.put(enc('evidence'));
    await writeFile(entryPath(hash), Buffer.from('garbage'));
    expect(await archive.put(enc('evidence'))).toMatchObject({ stored: true });
    expect(new TextDecoder().decode((await archive.get(hash)) ?? new Uint8Array())).toBe(
      'evidence',
    );
  });

  it('rejects documents above maxBytes', async () => {
    const small = new FileRawArchive(join(dir, 'small'), { maxBytes: 10 });
    await expect(small.put(new Uint8Array(11))).rejects.toThrow(RangeError);
  });

  describe('path traversal and hash validation', () => {
    const bad = [
      '../../etc/passwd',
      '..',
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `${'a'.repeat(62)}/.`,
      `../${'a'.repeat(61)}`,
      `${'a'.repeat(63)}\0`,
      `${'a'.repeat(64)}.gz`,
      `${'a'.repeat(32)}/../${'a'.repeat(28)}`,
      'g'.repeat(64),
    ];
    it('rejects anything but 64 lower-case hex characters in get and has', async () => {
      for (const h of bad) {
        await expect(archive.get(h)).rejects.toBeInstanceOf(InvalidArchiveHashError);
        await expect(archive.has(h)).rejects.toBeInstanceOf(InvalidArchiveHashError);
      }
      await expect(archive.get(123 as unknown as string)).rejects.toBeInstanceOf(
        InvalidArchiveHashError,
      );
    });
    it('property: any string that is not a valid hash is rejected, and nothing is written outside the store', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ maxLength: 100 }), async (s) => {
          fc.pre(!/^[0-9a-f]{64}$/.test(s));
          await expect(archive.get(s)).rejects.toBeInstanceOf(InvalidArchiveHashError);
        }),
        { numRuns: 60 },
      );
      expect(await readdir(dir)).toEqual([]);
    });
    it('a file placed outside the store is never reachable through a hash', async () => {
      await writeFile(join(dir, 'secret.gz'), gzipSync('secret'));
      await expect(archive.get('../secret')).rejects.toBeInstanceOf(InvalidArchiveHashError);
    });
  });

  describe('crash safety', () => {
    it('ignores partial temp files and cleans only old ones', async () => {
      const { hash } = await archive.put(enc('real'));
      const sub = join(dir, 'store', hash.slice(0, 2), hash.slice(2, 4));
      const partial = join(sub, `.${hash}.0123456789abcdef.tmp`);
      const fresh = join(sub, `.${hash}.fedcba9876543210.tmp`);
      await writeFile(partial, 'half a gz');
      await writeFile(fresh, 'half a gz');
      const old = new Date(T0.getTime() - 3 * DAY);
      await utimes(partial, old, old);
      await utimes(fresh, T0, T0);
      expect(await archive.has(hash)).toBe(true);
      expect(await archive.get(hash)).not.toBeNull();
      expect(await archive.cleanTemp({ olderThan: new Date(T0.getTime() - DAY) })).toBe(1);
      const left = await readdir(sub);
      expect(left).toContain(`.${hash}.fedcba9876543210.tmp`);
      expect(left).not.toContain(`.${hash}.0123456789abcdef.tmp`);
      expect(left).toContain(`${hash}.gz`);
    });

    it('a crashed write never makes a half file visible: only the temp name exists', async () => {
      const h = hashOf('crash');
      const sub = join(dir, 'store', h.slice(0, 2), h.slice(2, 4));
      await mkdir(sub, { recursive: true, mode: 0o700 });
      await writeFile(join(sub, `.${h}.aaaaaaaaaaaaaaaa.tmp`), gzipSync('crash').subarray(0, 8));
      expect(await archive.has(h)).toBe(false);
      expect(await archive.get(h)).toBeNull();
      expect(await archive.put(enc('crash'))).toMatchObject({ stored: true });
    });

    it('prune also sweeps old temp files', async () => {
      const { hash } = await archive.put(enc('x'));
      const sub = join(dir, 'store', hash.slice(0, 2), hash.slice(2, 4));
      const temp = join(sub, `.${hash}.0123456789abcdef.tmp`);
      await writeFile(temp, 'partial');
      await utimes(temp, new Date(T0.getTime() - 10 * DAY), new Date(T0.getTime() - 10 * DAY));
      clock = new Date(T0.getTime() + DAY);
      await archive.prune({ olderThan: new Date(T0.getTime() - 5 * DAY), keep: new Set() });
      expect(await readdir(sub)).not.toContain(`.${hash}.0123456789abcdef.tmp`);
    });
  });

  describe('prune', () => {
    it('removes old entries not in keep, honours keep, and spares new ones', async () => {
      const old1 = await archive.put(enc('old one'), {
        fetchedAt: new Date(T0.getTime() - 40 * DAY),
      });
      const old2 = await archive.put(enc('old two'), {
        fetchedAt: new Date(T0.getTime() - 40 * DAY),
      });
      const evidence = await archive.put(enc('evidence'), {
        fetchedAt: new Date(T0.getTime() - 400 * DAY),
      });
      const fresh = await archive.put(enc('fresh'), {
        fetchedAt: new Date(T0.getTime() - 1 * DAY),
      });
      const result = await archive.prune({
        olderThan: new Date(T0.getTime() - 30 * DAY),
        keep: new Set([evidence.hash]),
      });
      expect(result).toEqual({ removed: 2, kept: 2 });
      expect(await archive.has(old1.hash)).toBe(false);
      expect(await archive.has(old2.hash)).toBe(false);
      expect(await archive.has(evidence.hash)).toBe(true);
      expect(await archive.has(fresh.hash)).toBe(true);
    });

    it('a repeated put refreshes the age, so recently seen content survives', async () => {
      const first = await archive.put(enc('seen again'), {
        fetchedAt: new Date(T0.getTime() - 60 * DAY),
      });
      await archive.put(enc('seen again'), { fetchedAt: new Date(T0.getTime() - 1 * DAY) });
      const r = await archive.prune({
        olderThan: new Date(T0.getTime() - 30 * DAY),
        keep: new Set(),
      });
      expect(r).toEqual({ removed: 0, kept: 1 });
      expect(await archive.has(first.hash)).toBe(true);
    });

    it('works on an empty or missing archive and ignores unrelated files', async () => {
      expect(await archive.prune({ olderThan: T0, keep: new Set() })).toEqual({
        removed: 0,
        kept: 0,
      });
      await archive.put(enc('a'));
      await writeFile(join(dir, 'store', 'README'), 'not ours');
      await mkdir(join(dir, 'store', 'zz'));
      await writeFile(join(dir, 'store', 'zz', 'x.gz'), 'not ours');
      const r = await archive.prune({ olderThan: new Date(T0.getTime() + DAY), keep: new Set() });
      expect(r).toEqual({ removed: 1, kept: 0 });
      expect((await readFile(join(dir, 'store', 'README'))).toString()).toBe('not ours');
    });
  });

  it('property: put then get returns the same bytes under the SHA-256 of the bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2000 }), async (bytes) => {
        const { hash } = await archive.put(bytes);
        expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(await archive.get(hash)).toEqual(bytes);
      }),
      { numRuns: 40 },
    );
  });
});
