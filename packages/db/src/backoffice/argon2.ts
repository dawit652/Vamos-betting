import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from './staff-auth';

/**
 * The password hasher of players and staff: argon2id (the library default)
 * with the OWASP baseline (19 MiB, 2 passes, 1 lane) and, when configured,
 * PASSWORD_PEPPER as argon2's secret key (ASVS 2.4.5): the key lives outside
 * the database, so a stolen copy of the database alone cannot be cracked
 * offline.
 *
 * Hashes made with the pepper carry PEPPERED_HASH_PREFIX; hashes without it
 * (made before the pepper was set) still verify, and `needsRehash` tells the
 * sign-in to replace them with a peppered one. A peppered hash never verifies
 * without the pepper, so the pepper is kept with the backups' keys.
 *
 * Imported through the `@vamos/db/passwords` subpath only, never from the
 * package index: the API and the worker bundle @vamos/db, and only the API
 * (and the ops scripts it carries) ships @node-rs/argon2.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Prefix of the hashes made with the pepper (version 1 of the scheme). */
export const PEPPERED_HASH_PREFIX = 'pepper1:';

/** A PasswordHasher that also says when a stored hash should be replaced. */
export interface PepperedPasswordHasher extends PasswordHasher {
  /** True when `storedHash` was made without the configured pepper. */
  needsRehash(storedHash: string): boolean;
}

/** The hasher for PASSWORD_PEPPER (`config.passwordPepper`; undefined: no pepper). */
export function createPasswordHasher(pepper: string | undefined): PepperedPasswordHasher {
  const secret = pepper === undefined ? undefined : Buffer.from(pepper, 'utf8');
  return {
    hash: async (password) =>
      secret === undefined
        ? hash(password, ARGON2_OPTIONS)
        : `${PEPPERED_HASH_PREFIX}${await hash(password, { ...ARGON2_OPTIONS, secret })}`,
    verify: async (storedHash, password) => {
      try {
        if (!storedHash.startsWith(PEPPERED_HASH_PREFIX)) return await verify(storedHash, password);
        if (secret === undefined) return false;
        return await verify(storedHash.slice(PEPPERED_HASH_PREFIX.length), password, { secret });
      } catch {
        return false;
      }
    },
    needsRehash: (storedHash) =>
      secret !== undefined && !storedHash.startsWith(PEPPERED_HASH_PREFIX),
  };
}

/** Without a pepper (development, tests); production passes config.passwordPepper. */
export const argon2PasswordHasher: PepperedPasswordHasher = createPasswordHasher(undefined);
