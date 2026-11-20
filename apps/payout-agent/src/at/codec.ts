/**
 * Text on the modem's AT interface. With `AT+CSCS="UCS2"` a modem takes and
 * gives every string as UTF-16 code units in hex, so a menu in any script
 * (and its line breaks) travels on one line. That is the mode this agent
 * asks for; a modem that answers in plain text all the same is read as it is.
 */

export type ModemCharset = 'UCS2' | 'GSM';

/** UTF-16BE code units as upper-case hex. */
export function encodeUcs2Hex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    out += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** The text of UCS2 hex; null when `hex` is not that (odd length, other characters, empty). */
export function decodeUcs2Hex(hex: string): string | null {
  if (hex.length === 0 || hex.length % 4 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  let out = '';
  for (let i = 0; i < hex.length; i += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

/** A string as the modem wants it inside the quotes of a command. */
export function encodeModemString(text: string, charset: ModemCharset): string {
  return charset === 'UCS2' ? encodeUcs2Hex(text) : text;
}

/**
 * The `m` of `+CUSD: m[,"str"[,dcs]]` (3GPP TS 27.007): 0 the network needs
 * no answer (a final message), 1 it waits for an answer (the session is
 * open), 2 it ended the session, 3 another client answered, 4 not supported,
 * 5 the network timed out.
 */
export interface CusdEvent {
  status: number;
  /** The screen; null when the line carries none (or an empty one). */
  text: string | null;
  dcs: number | null;
}

/** Whether a data coding scheme says the text is UCS2 (general data coding, alphabet bits 10). */
function dcsIsUcs2(dcs: number | null): boolean {
  return dcs !== null && (dcs & 0x0c) === 0x08;
}

/** Parses one `+CUSD:` line (the text may hold quotes and line breaks); null when it is not one. */
export function parseCusd(line: string, charset: ModemCharset): CusdEvent | null {
  const match = /^\+CUSD:\s*(\d)(?:\s*,\s*"([\s\S]*)"(?:\s*,\s*(\d{1,3}))?)?\s*$/.exec(line);
  if (match === null) return null;
  const status = Number(match[1]);
  const raw = match[2];
  const dcs = match[3] === undefined ? null : Number(match[3]);
  if (raw === undefined || raw === '') return { status, text: null, dcs };
  // In UCS2 mode everything is hex; in GSM mode only a UCS2-coded message is. A modem that sends
  // plain text regardless is read as plain text.
  const hex = charset === 'UCS2' || dcsIsUcs2(dcs) ? decodeUcs2Hex(raw) : null;
  return { status, text: hex ?? raw, dcs };
}
