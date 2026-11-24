import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { alphabetOf, assembleParts, decodeDeliverPdu, parseCmglPdu } from '../src/sms/pdu';

/**
 * An SMS-DELIVER encoder for the tests, written from 3GPP TS 23.040 independently of the decoder
 * (bit by bit instead of shifting words), so the round trip checks one against the other.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXTENSION: Record<string, number> = { '{': 0x28, '}': 0x29, '[': 0x3c, ']': 0x3e, '€': 0x65 };

function septetsOf(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch in EXTENSION) out.push(0x1b, EXTENSION[ch]!);
    else {
      const code = GSM7.indexOf(ch);
      if (code < 0) throw new Error(`not GSM 7-bit: ${ch}`);
      out.push(code);
    }
  }
  return out;
}

/** Packs septets after `fillBits` zero bits, least significant bit first. */
function pack(septets: number[], fillBits = 0): number[] {
  const bits: number[] = Array<number>(fillBits).fill(0);
  for (const septet of septets) for (let b = 0; b < 7; b += 1) bits.push((septet >> b) & 1);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8 && i + b < bits.length; b += 1) byte |= bits[i + b]! << b;
    out.push(byte);
  }
  return out;
}

const hex = (bytes: number[]) =>
  bytes
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
const bcd = (n: number) => ((n % 10) << 4) | Math.floor(n / 10);

interface Encoded {
  sender: string;
  senderKind: 'international' | 'number' | 'name';
  /** Local time fields and the zone in quarter hours (negative west of Greenwich). */
  local: [number, number, number, number, number, number];
  zoneQuarters: number;
  text: string;
  alphabet: 'gsm7' | 'ucs2';
  part?: { reference: number; total: number; index: number; wide?: boolean };
}

function encodeDeliver(m: Encoded): string {
  const out: number[] = [0x07, 0x91, 0x52, 0x91, 0x00, 0x00, 0x00, 0xf0]; // a service centre
  out.push(0x04 | (m.part === undefined ? 0 : 0x40));
  if (m.senderKind === 'name') {
    const packed = pack(septetsOf(m.sender));
    out.push(Math.ceil((m.sender.length * 7) / 4), 0xd0, ...packed);
  } else {
    const digits = m.sender.replace(/^\+/, '');
    out.push(digits.length, m.senderKind === 'international' ? 0x91 : 0x81);
    for (let i = 0; i < digits.length; i += 2) {
      const low = Number(digits[i]);
      const high = i + 1 < digits.length ? Number(digits[i + 1]) : 0xf;
      out.push((high << 4) | low);
    }
  }
  out.push(0x00, m.alphabet === 'gsm7' ? 0x00 : 0x08);
  const [yy, mo, dd, hh, mi, ss] = m.local;
  const q = Math.abs(m.zoneQuarters);
  out.push(
    bcd(yy),
    bcd(mo),
    bcd(dd),
    bcd(hh),
    bcd(mi),
    bcd(ss),
    bcd(q) | (m.zoneQuarters < 0 ? 0x08 : 0),
  );
  const header: number[] = [];
  if (m.part !== undefined) {
    const { reference, total, index, wide } = m.part;
    if (wide === true) header.push(0x08, 0x04, reference >> 8, reference & 0xff, total, index);
    else header.push(0x00, 0x03, reference, total, index);
    header.unshift(header.length);
  }
  if (m.alphabet === 'gsm7') {
    const septets = septetsOf(m.text);
    const headerSeptets = Math.ceil((header.length * 8) / 7);
    const fill = headerSeptets * 7 - header.length * 8;
    const body = pack(septets, fill);
    out.push(headerSeptets + septets.length, ...header, ...body);
  } else {
    const body: number[] = [];
    for (const ch of m.text) {
      const code = ch.charCodeAt(0);
      body.push(code >> 8, code & 0xff);
    }
    out.push(header.length + body.length, ...header, ...body);
  }
  return hex(out);
}

const BASE: Encoded = {
  sender: '127',
  senderKind: 'number',
  local: [26, 11, 16, 14, 5, 9],
  zoneQuarters: 12, // +03:00, East Africa Time
  text: 'You have sent 1500.00 Birr to 0911234567. Transaction CK48XR21PQ.',
  alphabet: 'gsm7',
};

describe('decodeDeliverPdu', () => {
  it('reads the classic packing example "hellohello"', () => {
    expect(hex(pack(septetsOf('hellohello')))).toBe('E8329BFD4697D9EC37');
    const sms = decodeDeliverPdu(encodeDeliver({ ...BASE, text: 'hellohello' }));
    expect(sms?.text).toBe('hellohello');
  });

  it('reads the sender, the time in UTC and the text', () => {
    const sms = decodeDeliverPdu(encodeDeliver(BASE));
    expect(sms).toEqual({
      sender: '127',
      senderKind: 'number',
      sentAt: new Date('2026-11-16T11:05:09Z'),
      text: BASE.text,
      part: null,
    });
    const named = decodeDeliverPdu(
      encodeDeliver({ ...BASE, sender: 'telebirr', senderKind: 'name' }),
    );
    expect(named).toMatchObject({ sender: 'telebirr', senderKind: 'name' });
    const intl = decodeDeliverPdu(
      encodeDeliver({
        ...BASE,
        sender: '+251911234567',
        senderKind: 'international',
        zoneQuarters: -4,
      }),
    );
    expect(intl).toMatchObject({ sender: '+251911234567', senderKind: 'international' });
    expect(intl?.sentAt).toEqual(new Date('2026-11-16T15:05:09Z'));
  });

  it('reads Amharic in UCS2 and the GSM extension characters', () => {
    const amharic = 'ብር 1,500.00 ተልኳል።';
    expect(
      decodeDeliverPdu(encodeDeliver({ ...BASE, alphabet: 'ucs2', text: amharic }))?.text,
    ).toBe(amharic);
    expect(decodeDeliverPdu(encodeDeliver({ ...BASE, text: 'Fee {2} [ok] €1' }))?.text).toBe(
      'Fee {2} [ok] €1',
    );
  });

  it('reads the part numbers of a long message, with an 8-bit or a 16-bit reference', () => {
    for (const wide of [false, true]) {
      const sms = decodeDeliverPdu(
        encodeDeliver({
          ...BASE,
          part: { reference: wide ? 0x1234 : 0x42, total: 3, index: 2, wide },
        }),
      );
      expect(sms?.part).toEqual({ reference: wide ? 0x1234 : 0x42, total: 3, index: 2 });
      expect(sms?.text).toBe(BASE.text);
    }
  });

  it('refuses what is not a whole SMS-DELIVER, never guesses', () => {
    const good = encodeDeliver(BASE);
    for (const bad of [
      '',
      'XYZ',
      good.slice(0, -2), // one octet short of its stated length? the text then ends early
      good.slice(0, 30), // cut in the time stamp
      good.replace(/^(07915291000000F0)04/, '$101'), // an SMS-SUBMIT, not a DELIVER
      good.replace(/^(07915291000000F0)04(03)(81)/, '$1$2$3'.replace('$3', 'A1')) + 'ZZ',
    ]) {
      expect(decodeDeliverPdu(bad), bad.slice(0, 40)).toBeNull();
    }
    // A compressed coding is not read.
    expect(alphabetOf(0x20)).toBeNull();
    expect(alphabetOf(0x08)).toBe('ucs2');
    expect(alphabetOf(0xf4)).toBe('octets');
  });

  it('property: whatever is encoded is decoded exactly', () => {
    const gsmText = fc
      .array(fc.constantFrom(...[...GSM7].filter((c) => c !== '\u001b'), '{', '}', '€'), {
        maxLength: 140,
      })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ alphabet: fc.constant('gsm7' as const), text: gsmText }),
          fc.record({
            alphabet: fc.constant('ucs2' as const),
            text: fc
              .string({ maxLength: 60, unit: 'binary' })
              .filter((t) => [...t].every((c) => c.length === 1)),
          }),
        ),
        fc.boolean(),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: -48, max: 56 }),
        (body, withPart, reference, zone) => {
          const encoded: Encoded = {
            ...BASE,
            ...body,
            zoneQuarters: zone,
            ...(withPart ? { part: { reference, total: 2, index: 1 } } : {}),
          };
          const sms = decodeDeliverPdu(encodeDeliver(encoded));
          expect(sms?.text).toBe(body.text);
          expect(sms?.part).toEqual(withPart ? { reference, total: 2, index: 1 } : null);
          const local = Date.UTC(2026, 10, 16, 14, 5, 9);
          expect(sms?.sentAt.getTime()).toBe(local - zone * 15 * 60_000);
        },
      ),
    );
  });
});

describe('reading the SIM and joining long messages', () => {
  it('lists messages from an AT+CMGL answer', () => {
    const lines = ['+CMGL: 3,1,,60', encodeDeliver(BASE), '+CMGL: 7,0,,12', 'NOT A PDU'];
    const listed = parseCmglPdu(lines);
    expect(listed.map((l) => l.index)).toEqual([3, 7]);
    expect(listed[0]?.sms?.text).toBe(BASE.text);
    expect(listed[1]?.sms).toBeNull();
  });

  it('joins the parts of a long message in order, and keeps waiting for a missing one', () => {
    const text = [
      'You have sent 1500.00 Birr to ',
      'ABEBE KEBEDE 0911234567. ',
      'Transaction CK48XR21PQ.',
    ];
    const part = (index: number, at: number) => ({
      index: at,
      sms: decodeDeliverPdu(
        encodeDeliver({
          ...BASE,
          text: text[index - 1]!,
          local: [26, 11, 16, 14, 5, 9 + index],
          part: { reference: 9, total: 3, index },
        }),
      ),
    });
    const single = {
      index: 1,
      sms: decodeDeliverPdu(encodeDeliver({ ...BASE, text: 'Balance check' })),
    };
    const all = assembleParts([part(3, 12), single, part(1, 10), part(2, 11), part(2, 13)]);
    expect(all.waiting).toEqual([]);
    // Oldest first: the single message was stamped a second before the long one's first part.
    expect(all.messages.map((m) => m.text)).toEqual(['Balance check', text.join('')]);
    expect(all.messages[1]?.indexes).toEqual([10, 11, 12]);
    expect(all.messages[1]?.sentAt).toEqual(new Date('2026-11-16T11:05:10Z'));

    const partial = assembleParts([part(1, 10), part(3, 12)]);
    expect(partial.messages).toEqual([]);
    expect(partial.waiting.sort()).toEqual([10, 12]);
  });

  it('never joins parts of different senders or references', () => {
    const make = (sender: string, reference: number, index: number) => ({
      index: index + reference,
      sms: decodeDeliverPdu(
        encodeDeliver({
          ...BASE,
          sender,
          text: `${sender}-${index}`,
          part: { reference, total: 2, index },
        }),
      ),
    });
    const result = assembleParts([make('127', 1, 1), make('128', 1, 2), make('127', 2, 2)]);
    expect(result.messages).toEqual([]);
    expect(result.waiting).toHaveLength(3);
  });
});
