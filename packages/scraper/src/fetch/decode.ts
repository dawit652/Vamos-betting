import type { RawDocument } from '../types';
import type { FetchOk } from './types';

export interface DecodedBody {
  text: string;
  /** The encoding actually used (lower-case label). */
  charset: string;
  source: 'header' | 'bom' | 'meta' | 'default';
  /** Some declared charset label was unknown and ignored. */
  fallback: boolean;
}

function tryDecoder(label: string): InstanceType<typeof TextDecoder> | null {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return null;
  }
}

function headerCharset(contentType: string | null): string | null {
  if (contentType === null) return null;
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  const label = (m?.[1] ?? m?.[2] ?? '').trim();
  return label === '' ? null : label;
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/** `<meta charset>` / `<meta http-equiv content="...charset=">` / `<?xml encoding=?>` in the first 2 KB. */
function sniffedCharset(bytes: Uint8Array, contentType: string | null): string | null {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  let m: RegExpExecArray | null = null;
  if (type === '' || type === 'text/html' || type === 'application/xhtml+xml') {
    m = /<meta[^>]{0,500}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  }
  if (m === null && (type.includes('xml') || type === '')) {
    m = /^\s*<\?xml[^>]{0,200}?encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  }
  const label = m?.[1];
  if (label === undefined) return null;
  // A page cannot be UTF-16 if we just read its ASCII declaration (WHATWG: treat as UTF-8).
  return /^utf-?16/i.test(label) ? 'utf-8' : label;
}

/**
 * Decodes response bytes to text. Charset order: Content-Type header, then BOM,
 * then a declaration in the first 2 KB, then UTF-8. An unknown label is skipped
 * and reported in `fallback`. Invalid sequences become U+FFFD; this never throws.
 */
export function decodeBodyDetailed(bytes: Uint8Array, contentType: string | null): DecodedBody {
  let fallback = false;
  const candidates: [string | null, DecodedBody['source']][] = [
    [headerCharset(contentType), 'header'],
    [bomCharset(bytes), 'bom'],
  ];
  for (const [label, source] of candidates) {
    if (label === null) continue;
    const decoder = tryDecoder(label);
    if (decoder === null) {
      fallback = true;
      continue;
    }
    return { text: decoder.decode(bytes), charset: decoder.encoding, source, fallback };
  }
  const meta = sniffedCharset(bytes, contentType);
  if (meta !== null) {
    const decoder = tryDecoder(meta);
    if (decoder !== null) {
      return { text: decoder.decode(bytes), charset: decoder.encoding, source: 'meta', fallback };
    }
    fallback = true;
  }
  return {
    text: new TextDecoder('utf-8').decode(bytes),
    charset: 'utf-8',
    source: 'default',
    fallback,
  };
}

export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  return decodeBodyDetailed(bytes, contentType).text;
}

/** Turns a successful fetch into the document an adapter parses. */
export function toRawDocument(sourceId: string, ok: FetchOk): RawDocument {
  return {
    sourceId,
    url: ok.url,
    status: ok.status,
    contentType: ok.contentType,
    body: decodeBody(ok.body, ok.contentType),
    fetchedAt: ok.fetchedAt,
    contentHash: ok.contentHash,
  };
}
