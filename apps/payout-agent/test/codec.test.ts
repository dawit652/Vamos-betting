import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeUcs2Hex, encodeUcs2Hex, parseCusd } from '../src/at/codec';

describe('UCS2 hex', () => {
  it('writes what the modem wants and reads it back, in any script', () => {
    expect(encodeUcs2Hex('*127#')).toBe('002A0031003200370023');
    expect(decodeUcs2Hex('002A0031003200370023')).toBe('*127#');
    expect(decodeUcs2Hex(encodeUcs2Hex('ገንዘብ ላክ\n1. አረጋግጥ'))).toBe('ገንዘብ ላክ\n1. አረጋግጥ');
    fc.assert(
      fc.property(
        fc.string(),
        (text) => decodeUcs2Hex(encodeUcs2Hex(text)) === (text === '' ? null : text),
      ),
    );
  });

  it('is null for anything that is not UCS2 hex', () => {
    for (const bad of ['', '0', '002', '00ZZ', 'Enter PIN', '0031 0032']) {
      expect(decodeUcs2Hex(bad), bad).toBeNull();
    }
  });
});

describe('parseCusd', () => {
  it('reads the status, the text and the coding', () => {
    expect(parseCusd('+CUSD: 1,"0045006E007400650072002000500049004E",72', 'UCS2')).toEqual({
      status: 1,
      text: 'Enter PIN',
      dcs: 72,
    });
    expect(parseCusd('+CUSD: 0,"Done",15', 'GSM')).toEqual({ status: 0, text: 'Done', dcs: 15 });
    expect(parseCusd('+CUSD: 2', 'UCS2')).toEqual({ status: 2, text: null, dcs: null });
    expect(parseCusd('+CUSD: 1,"",15', 'GSM')).toEqual({ status: 1, text: null, dcs: 15 });
  });

  it('keeps quotes and line breaks that are part of the text', () => {
    expect(parseCusd('+CUSD: 1,"Send to "ABEBE"?\n1. Yes",15', 'GSM')).toEqual({
      status: 1,
      text: 'Send to "ABEBE"?\n1. Yes',
      dcs: 15,
    });
  });

  it('reads a UCS2-coded message in GSM mode, and plain text from a modem that ignores UCS2 mode', () => {
    expect(parseCusd('+CUSD: 0,"004F004B",72', 'GSM')?.text).toBe('OK');
    expect(parseCusd('+CUSD: 0,"Enter PIN",15', 'UCS2')?.text).toBe('Enter PIN');
  });

  it('is null for a line that is not a +CUSD line', () => {
    for (const line of ['OK', '+CUSD:', '+CUSD: x', '+CMTI: "SM",3', '+CUSD: 1,"open']) {
      expect(parseCusd(line, 'UCS2'), line).toBeNull();
    }
  });
});
