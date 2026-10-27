import { describe, expect, it } from 'vitest';
import {
  argon2PasswordHasher,
  createPasswordHasher,
  PEPPERED_HASH_PREFIX,
} from '../src/backoffice/argon2';

const PEPPER = 'a-test-password-pepper-of-32-characters!';

describe('password hashing with a pepper (ASVS 2.4.1, 2.4.5)', () => {
  it('hashes with argon2id and the pepper, which every check then needs', async () => {
    const peppered = createPasswordHasher(PEPPER);
    const stored = await peppered.hash('Abebe-bikila-1960');
    expect(stored.startsWith(`${PEPPERED_HASH_PREFIX}$argon2id$v=19$m=19456,t=2,p=1$`)).toBe(true);
    expect(await peppered.verify(stored, 'Abebe-bikila-1960')).toBe(true);
    expect(await peppered.verify(stored, 'abebe-bikila-1960')).toBe(false);
    // Without the pepper, or with another one, the hash is useless.
    expect(await argon2PasswordHasher.verify(stored, 'Abebe-bikila-1960')).toBe(false);
    expect(await createPasswordHasher(`${PEPPER}-other`).verify(stored, 'Abebe-bikila-1960')).toBe(
      false,
    );
    // Unique salt per hash.
    expect(await peppered.hash('Abebe-bikila-1960')).not.toBe(stored);
    expect(peppered.needsRehash(stored)).toBe(false);
  });

  it('still verifies hashes made before the pepper, and asks for them to be replaced', async () => {
    const legacy = await argon2PasswordHasher.hash('Abebe-bikila-1960');
    const peppered = createPasswordHasher(PEPPER);
    expect(await peppered.verify(legacy, 'Abebe-bikila-1960')).toBe(true);
    expect(peppered.needsRehash(legacy)).toBe(true);
    expect(argon2PasswordHasher.needsRehash(legacy)).toBe(false);
    expect(await peppered.verify('not-a-hash', 'anything')).toBe(false);
    expect(await peppered.verify(`${PEPPERED_HASH_PREFIX}garbage`, 'anything')).toBe(false);
  });
});
