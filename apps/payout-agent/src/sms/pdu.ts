/**
 * Reading an SMS the way a modem hands it over in PDU mode (`AT+CMGF=0`,
 * `AT+CMGL=4`): the raw SMS-DELIVER of 3GPP TS 23.040. The payout SIM's own
 * messages are the proof that a transfer went out ("You have sent …"), so
 * they are read here exactly: the sender (a number, or a name such as
 * "telebirr"), the time the service centre stamped, and the text in any of
 * the three alphabets (GSM 7-bit, 8-bit, UCS2). A long message comes in
 * parts with a shared reference; `assembleParts` puts them together.
 *
 * Pure. Anything malformed is refused (null), never guessed.
 */

export interface DeliveredSms {
  /** `+2519…` for an international number, the digits as given otherwise, or the sender's name. */
  sender: string;
  senderKind: 'international' | 'number' | 'name';
  /** The service centre's time stamp (UTC). */
  sentAt: Date;
  text: string;
  /** Set when the message is one part of a longer one. */
  part: { reference: number; total: number; index: number } | null;
}

/** GSM 03.38 default alphabet. */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** GSM 03.38 extension table (after the escape 0x1B). */
const GSM7_EXTENSION: Readonly<Record<number, string>> = {
  0x0a: '\f',
  0x14: '^',
  0x28: '{',
  0x29: '}',
  0x2f: '\\',
  0x3c: '[',
  0x3d: '~',
  0x3e: ']',
  0x40: '|',
  0x65: '€',
};

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get left(): number {
    return this.bytes.length - this.at;
  }
  octet(): number {
    if (this.at >= this.bytes.length) throw new RangeError('the PDU ends early');
    const value = this.bytes[this.at];
    this.at += 1;
    return value ?? 0;
  }
  take(count: number): Uint8Array {
    if (count < 0 || this.at + count > this.bytes.length)
      throw new RangeError('the PDU ends early');
    const out = this.bytes.slice(this.at, this.at + count);
    this.at += count;
    return out;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Semi-octets (swapped nibbles), stopping at the filler F. */
function semiOctets(bytes: Uint8Array, digits: number): string {
  let out = '';
  for (const byte of bytes) {
    for (const nibble of [byte & 0x0f, byte >> 4]) {
      if (out.length >= digits || nibble === 0x0f) return out;
      if (nibble > 9) throw new RangeError('a number holds a non-digit');
      out += String(nibble);
    }
  }
  return out;
}

/** Septets packed into octets, read from bit `skipBits` on. */
function unpackSeptets(bytes: Uint8Array, count: number, skipBits = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const bit = skipBits + i * 7;
    const at = bit >> 3;
    const shift = bit & 7;
    const low = bytes[at];
    if (low === undefined) throw new RangeError('the PDU ends early');
    const high = bytes[at + 1] ?? 0;
    out.push((((high << 8) | low) >> shift) & 0x7f);
  }
  return out;
}

function gsm7Text(septets: readonly number[]): string {
  let out = '';
  for (let i = 0; i < septets.length; i += 1) {
    const code = septets[i] ?? 0;
    if (code === 0x1b && i + 1 < septets.length) {
      const next = septets[i + 1] ?? 0;
      out += GSM7_EXTENSION[next] ?? GSM7[next] ?? '';
      i += 1;
    } else {
      out += GSM7[code] ?? '';
    }
  }
  return out;
}

function ucs2Text(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new RangeError('UCS2 text of an odd length');
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return out;
}

type Alphabet = 'gsm7' | 'octets' | 'ucs2';

/** The alphabet of a data coding scheme; null for a compressed or reserved one. */
export function alphabetOf(dcs: number): Alphabet | null {
  const group = dcs >> 4;
  if (group <= 0x7) {
    // General data coding (00xx) and the automatic-deletion group (01xx).
    if ((dcs & 0x20) !== 0) return null; // compressed
    const alphabet = (dcs >> 2) & 0x03;
    return alphabet === 0 ? 'gsm7' : alphabet === 1 ? 'octets' : alphabet === 2 ? 'ucs2' : null;
  }
  if (group === 0xc || group === 0xd) return 'gsm7';
  if (group === 0xe) return 'ucs2';
  if (group === 0xf) return (dcs & 0x04) === 0 ? 'gsm7' : 'octets';
  return null;
}

/** The service centre time stamp: seven semi-octet pairs, the zone in quarter hours. */
function timeStamp(bytes: Uint8Array): Date {
  const swap = (byte: number) => (byte & 0x0f) * 10 + (byte >> 4);
  const [yy, mo, dd, hh, mi, ss, tz] = [...bytes].map((b, i) => (i === 6 ? b : swap(b)));
  if (tz === undefined) throw new RangeError('the PDU ends early');
  const quarters = (tz & 0x07) * 10 + (tz >> 4);
  const offsetMs = ((tz & 0x08) === 0 ? 1 : -1) * quarters * 15 * 60_000;
  const local = Date.UTC(2000 + (yy ?? 0), (mo ?? 1) - 1, dd ?? 1, hh ?? 0, mi ?? 0, ss ?? 0);
  const date = new Date(local - offsetMs);
  if (
    (mo ?? 0) < 1 ||
    (mo ?? 0) > 12 ||
    (dd ?? 0) < 1 ||
    (dd ?? 0) > 31 ||
    (hh ?? 0) > 23 ||
    (mi ?? 0) > 59 ||
    (ss ?? 0) > 59 ||
    Number.isNaN(date.getTime())
  ) {
    throw new RangeError('the time stamp is not a time');
  }
  return date;
}

/** One SMS-DELIVER PDU as the modem gives it (hex, with the service centre field in front). */
export function decodeDeliverPdu(hex: string): DeliveredSms | null {
  const bytes = hexToBytes(hex);
  if (bytes === null) return null;
  try {
    const r = new Reader(bytes);
    r.take(r.octet()); // the service centre's address
    const first = r.octet();
    if ((first & 0x03) !== 0x00) return null; // not an SMS-DELIVER
    const hasHeader = (first & 0x40) !== 0;

    const digits = r.octet();
    const toa = r.octet();
    const address = r.take(Math.ceil(digits / 2));
    let sender: string;
    let senderKind: DeliveredSms['senderKind'];
    if (((toa >> 4) & 0x07) === 0x05) {
      sender = gsm7Text(unpackSeptets(address, Math.floor((digits * 4) / 7))).trim();
      senderKind = 'name';
    } else {
      const number = semiOctets(address, digits);
      const international = ((toa >> 4) & 0x07) === 0x01;
      sender = international ? `+${number}` : number;
      senderKind = international ? 'international' : 'number';
    }
    if (sender === '') return null;

    r.octet(); // protocol identifier
    const alphabet = alphabetOf(r.octet());
    if (alphabet === null) return null;
    const sentAt = timeStamp(r.take(7));
    const length = r.octet();
    const data = r.take(r.left);

    let part: DeliveredSms['part'] = null;
    let headerOctets = 0;
    if (hasHeader) {
      const headerLength = data[0];
      if (headerLength === undefined || headerLength + 1 > data.length) return null;
      headerOctets = headerLength + 1;
      for (let at = 1; at < headerOctets;) {
        const id = data[at];
        const size = data[at + 1];
        if (id === undefined || size === undefined || at + 2 + size > headerOctets) return null;
        const body = data.slice(at + 2, at + 2 + size);
        if (id === 0x00 && size === 3) {
          part = { reference: body[0] ?? 0, total: body[1] ?? 0, index: body[2] ?? 0 };
        } else if (id === 0x08 && size === 4) {
          part = {
            reference: ((body[0] ?? 0) << 8) | (body[1] ?? 0),
            total: body[2] ?? 0,
            index: body[3] ?? 0,
          };
        }
        at += 2 + size;
      }
      if (part !== null && (part.total < 1 || part.index < 1 || part.index > part.total)) {
        return null;
      }
    }

    let text: string;
    if (alphabet === 'gsm7') {
      // The length counts septets, the header included (padded to a septet boundary).
      const headerSeptets = Math.ceil((headerOctets * 8) / 7);
      if (length < headerSeptets || Math.ceil((length * 7) / 8) > data.length) return null;
      text = gsm7Text(unpackSeptets(data, length - headerSeptets, headerSeptets * 7));
    } else {
      if (length > data.length || length < headerOctets) return null;
      const body = data.slice(headerOctets, length);
      text = alphabet === 'ucs2' ? ucs2Text(body) : new TextDecoder('latin1').decode(body);
    }
    return { sender, senderKind, sentAt, text, part };
  } catch {
    return null;
  }
}

/** One `+CMGL:` entry: the storage index and the decoded message (null when it could not be read). */
export interface ListedSms {
  index: number;
  sms: DeliveredSms | null;
}

/** The answer to `AT+CMGL=4` in PDU mode: header lines each followed by the PDU line. */
export function parseCmglPdu(lines: readonly string[]): ListedSms[] {
  const out: ListedSms[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\+CMGL:\s*(\d+)\s*,/.exec(lines[i] ?? '');
    if (header === null) continue;
    const pdu = lines[i + 1] ?? '';
    out.push({ index: Number(header[1]), sms: decodeDeliverPdu(pdu) });
    i += 1;
  }
  return out;
}

/** A message put together from its parts. */
export interface AssembledSms {
  sender: string;
  /** The earliest time stamp of its parts. */
  sentAt: Date;
  text: string;
  /** The storage indexes of every part (to delete once forwarded). */
  indexes: number[];
}

/**
 * Whole messages from listed parts: single messages as they are, parts joined
 * in order once all of them are there. Parts still missing are left out (and
 * listed in `waiting`), to be read again on the next round.
 */
export function assembleParts(listed: readonly ListedSms[]): {
  messages: AssembledSms[];
  waiting: number[];
} {
  const messages: AssembledSms[] = [];
  const groups = new Map<
    string,
    { total: number; parts: Map<number, ListedSms & { sms: DeliveredSms }> }
  >();
  for (const entry of listed) {
    const sms = entry.sms;
    if (sms === null) continue;
    if (sms.part === null || sms.part.total === 1) {
      messages.push({
        sender: sms.sender,
        sentAt: sms.sentAt,
        text: sms.text,
        indexes: [entry.index],
      });
      continue;
    }
    const key = `${sms.sender}\u0000${sms.part.reference}\u0000${sms.part.total}`;
    const group = groups.get(key) ?? { total: sms.part.total, parts: new Map() };
    // A repeated part (the same index twice) keeps the first one read.
    if (!group.parts.has(sms.part.index)) group.parts.set(sms.part.index, { ...entry, sms });
    groups.set(key, group);
  }
  const waiting: number[] = [];
  for (const group of groups.values()) {
    const parts = [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
    if (parts.length !== group.total) {
      waiting.push(...parts.map((p) => p.index));
      continue;
    }
    const first = parts[0];
    if (first === undefined) continue;
    messages.push({
      sender: first.sms.sender,
      sentAt: new Date(Math.min(...parts.map((p) => p.sms.sentAt.getTime()))),
      text: parts.map((p) => p.sms.text).join(''),
      indexes: parts.map((p) => p.index),
    });
  }
  messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return { messages, waiting };
}
