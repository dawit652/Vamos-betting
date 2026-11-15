import { describe, expect, it } from 'vitest';
import { DEMO_STAFF_PASSWORD, DEMO_STAFF_TOTP_SECRET } from '../src/backoffice/demo-staff-accounts';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  TotpSecretError,
} from '../src/backoffice/secret-box';
import {
  base32Decode,
  base32Encode,
  hotp,
  totpCode,
  totpStep,
  totpUri,
  verifyTotp,
  type OtpAlgorithm,
} from '../src/backoffice/totp';

/** RFC 4226 Appendix D: HOTP of the ASCII secret "12345678901234567890", 6 digits. */
const RFC4226_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC4226_CODES = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];

/** RFC 6238 Appendix B: the seeds are the ASCII digits repeated to the hash's size. */
const RFC6238_SECRETS: Record<OtpAlgorithm, Buffer> = {
  sha1: Buffer.from('12345678901234567890', 'ascii'),
  sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
};

/** RFC 6238 Appendix B: [unix seconds, T (hex), SHA-1, SHA-256, SHA-512], 8 digits, 30 s steps. */
const RFC6238_VECTORS: Array<[number, string, string, string, string]> = [
  [59, '0000000000000001', '94287082', '46119246', '90693936'],
  [1111111109, '00000000023523EC', '07081804', '68084774', '25091201'],
  [1111111111, '00000000023523ED', '14050471', '67062674', '99943326'],
  [1234567890, '000000000273EF07', '89005924', '91819424', '93441116'],
  [2000000000, '0000000003F940AA', '69279037', '90698825', '38618901'],
  [20000000000, '0000000027BC86AA', '65353130', '77737706', '47863826'],
];

describe('HOTP (RFC 4226)', () => {
  it('matches the Appendix D test values', () => {
    RFC4226_CODES.forEach((code, counter) => {
      expect(hotp(RFC4226_SECRET, counter)).toBe(code);
      expect(hotp(RFC4226_SECRET, BigInt(counter))).toBe(code);
    });
  });

  it('refuses digits outside 6..8, an empty secret and a counter out of range', () => {
    expect(() => hotp(RFC4226_SECRET, 0, { digits: 5 })).toThrow(RangeError);
    expect(() => hotp(RFC4226_SECRET, 0, { digits: 9 })).toThrow(RangeError);
    expect(() => hotp(Buffer.alloc(0), 0)).toThrow(RangeError);
    expect(() => hotp(RFC4226_SECRET, -1)).toThrow(RangeError);
    expect(() => hotp(RFC4226_SECRET, 2n ** 64n)).toThrow(RangeError);
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches every Appendix B test vector (SHA-1, SHA-256, SHA-512)', () => {
    for (const [seconds, stepHex, sha1, sha256, sha512] of RFC6238_VECTORS) {
      const timeMs = seconds * 1000;
      expect(totpStep(timeMs)).toBe(Number.parseInt(stepHex, 16));
      const expected: Record<OtpAlgorithm, string> = { sha1, sha256, sha512 };
      for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) {
        expect(
          totpCode(RFC6238_SECRETS[algorithm], timeMs, { digits: 8, algorithm }),
          `${algorithm} at ${seconds}`,
        ).toBe(expected[algorithm]);
      }
    }
  });

  it('uses 6-digit SHA-1 codes in 30-second steps by default', () => {
    // The last six digits of the 8-digit SHA-1 vector (the same HMAC truncation, mod 10^6).
    expect(totpCode(RFC6238_SECRETS.sha1, 59_000)).toBe('287082');
    expect(totpCode(RFC6238_SECRETS.sha1, 1111111109_000)).toBe('081804');
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
  });

  it('accepts a code one step either side of now and nothing further', () => {
    const secret = RFC6238_SECRETS.sha1;
    const now = 1_234_567_890_000;
    const step = totpStep(now);
    const at = (offset: number) => hotp(secret, step + offset);
    expect(verifyTotp(secret, at(0), now)).toBe(step);
    expect(verifyTotp(secret, at(-1), now)).toBe(step - 1);
    expect(verifyTotp(secret, at(1), now)).toBe(step + 1);
    expect(verifyTotp(secret, at(-2), now)).toBeNull();
    expect(verifyTotp(secret, at(2), now)).toBeNull();
    expect(verifyTotp(secret, at(-2), now, { window: 2 })).toBe(step - 2);
    expect(verifyTotp(secret, at(1), now, { window: 0 })).toBeNull();
  });

  it('accepts only a step later than the last one used (replay guard)', () => {
    const secret = RFC6238_SECRETS.sha1;
    const now = 1_234_567_890_000;
    const step = totpStep(now);
    const current = hotp(secret, step);
    expect(verifyTotp(secret, current, now, { afterStep: step - 1 })).toBe(step);
    expect(verifyTotp(secret, current, now, { afterStep: step })).toBeNull();
    // An older code still inside the window is refused once a newer one was used.
    expect(verifyTotp(secret, hotp(secret, step - 1), now, { afterStep: step })).toBeNull();
    // The next step's code is still accepted.
    expect(verifyTotp(secret, hotp(secret, step + 1), now, { afterStep: step })).toBe(step + 1);
  });

  it('never matches malformed codes', () => {
    const secret = RFC6238_SECRETS.sha1;
    const now = 59_000;
    const code = totpCode(secret, now);
    for (const bad of ['', '12345', '1234567', ` ${code}`, `${code.slice(0, 5)}a`, '२८७०८२']) {
      expect(verifyTotp(secret, bad, now), bad).toBeNull();
    }
    expect(verifyTotp(secret, 287082 as unknown as string, now)).toBeNull();
    expect(() => verifyTotp(secret, code, now, { window: -1 })).toThrow(RangeError);
    expect(() => verifyTotp(secret, code, now, { window: 11 })).toThrow(RangeError);
  });
});

describe('base32 (RFC 4648)', () => {
  it('encodes and decodes the RFC test vectors (without padding)', () => {
    const vectors: Array<[string, string]> = [
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
      expect(base32Decode(encoded).toString('ascii')).toBe(plain);
    }
    // Padding, lower case, spaces and hyphens are ignored when decoding.
    expect(base32Decode('mzxw 6ytb-oi======').toString('ascii')).toBe('foobar');
  });

  it('round-trips random secrets and refuses invalid text', () => {
    for (let size = 1; size <= 40; size += 1) {
      const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 37 + size) & 0xff));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(() => base32Decode('')).toThrow(RangeError);
    expect(() => base32Decode('MZXW1')).toThrow(RangeError);
    expect(() => base32Decode('M')).toThrow(RangeError);
  });

  it('decodes the published demo staff secret to 20 bytes', () => {
    const secret = base32Decode(DEMO_STAFF_TOTP_SECRET);
    expect(secret.length).toBe(20);
    expect(base32Encode(secret)).toBe(DEMO_STAFF_TOTP_SECRET);
    expect(DEMO_STAFF_PASSWORD.length).toBeGreaterThanOrEqual(12);
  });
});

describe('totpUri', () => {
  it('builds the otpauth URI authenticator apps scan', () => {
    const uri = totpUri({
      secret: Buffer.from('foobar', 'ascii'),
      account: 'ops@vamos.test',
      issuer: 'Nahubet Back Office',
    });
    expect(uri).toBe(
      'otpauth://totp/Nahubet%20Back%20Office:ops%40vamos.test?secret=MZXW6YTBOI' +
        '&issuer=Nahubet%20Back%20Office&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('TOTP secret encryption (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 7);
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const owner = '0b6f6a37-5d39-4a0e-9a53-2c4b0b9b7a11';

  it('decrypts what it encrypted for the same account, with a fresh IV each time', () => {
    const first = encryptTotpSecret(key, secret, owner);
    const second = encryptTotpSecret(key, secret, owner);
    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(secret.toString('base64url'));
    expect(decryptTotpSecret(key, first, owner).equals(secret)).toBe(true);
    expect(decryptTotpSecret(key, second, owner).equals(secret)).toBe(true);
  });

  it('refuses another key, another account, tampering and unknown formats', () => {
    const stored = encryptTotpSecret(key, secret, owner);
    expect(() => decryptTotpSecret(Buffer.alloc(32, 8), stored, owner)).toThrow(TotpSecretError);
    expect(() => decryptTotpSecret(key, stored, '7c1d1e0e-2f5a-4c3b-8d6e-9f0a1b2c3d4e')).toThrow(
      TotpSecretError,
    );
    const parts = stored.split('.');
    const ciphertext = Buffer.from(parts[2]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = [parts[0], parts[1], ciphertext.toString('base64url'), parts[3]].join('.');
    expect(() => decryptTotpSecret(key, tampered, owner)).toThrow(TotpSecretError);
    for (const bad of ['', 'v2.a.b.c', 'v1.a.b', `${stored}.x`, 'v1.!!.b.c']) {
      expect(() => decryptTotpSecret(key, bad, owner), bad).toThrow(TotpSecretError);
    }
  });

  it('needs a 32-byte key and an account id', () => {
    expect(() => encryptTotpSecret(Buffer.alloc(16), secret, owner)).toThrow(RangeError);
    expect(() => encryptTotpSecret(key, secret, '')).toThrow(RangeError);
    expect(() => encryptTotpSecret(key, Buffer.alloc(0), owner)).toThrow(RangeError);
  });
});
