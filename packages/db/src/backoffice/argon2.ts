import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from './staff-auth';

/**
 * The staff password hasher for the CLI, the demo seed and tests: argon2id
 * (the library default) with the OWASP baseline the player passwords use
 * (19 MiB, 2 passes, 1 lane; apps/api/src/lib/passwords.ts).
 *
 * Imported through the `@vamos/db/passwords` subpath only, never from the
 * package index: the API and the worker bundle @vamos/db, and only the API
 * ships @node-rs/argon2 (it passes its own hasher to the staff services).
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_OPTIONS),
  verify: async (storedHash, password) => {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  },
};
