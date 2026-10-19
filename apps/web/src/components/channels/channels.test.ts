import { describe, expect, it } from 'vitest';
import {
  appendUssdInput,
  cleanUssdInput,
  isDevId,
  isServiceCodeDial,
  mergeThread,
  newDevId,
  parseUssdResponse,
  smsParts,
} from './channels';

describe('dev ids', () => {
  it('always match the dev route pattern, whatever the random source', () => {
    for (const r of [0, 0.5, 0.999999, 1]) {
      expect(isDevId(newDevId('sms', () => r))).toBe(true);
      expect(isDevId(newDevId('ussd', () => r))).toBe(true);
    }
    expect(isDevId(newDevId('sms'))).toBe(true);
    expect(isDevId('short')).toBe(false);
    expect(isDevId('has space here')).toBe(false);
  });
});

describe('sms parts', () => {
  it('counts GSM-7 and Amharic parts', () => {
    expect(smsParts('')).toBe(0);
    expect(smsParts('BAL')).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
    expect(smsParts('ሰላም')).toBe(1);
    expect(smsParts('ሰ'.repeat(71))).toBe(2);
  });
});

describe('mergeThread', () => {
  it('orders texts and replies, drops replies from before the page opened', () => {
    const sent = [{ direction: 'out' as const, body: 'BAL', at: '2026-01-01T10:00:00.000Z' }];
    const inbox = [
      { body: 'old', createdAt: '2026-01-01T09:00:00.000Z' },
      { body: 'Balance ETB 5', createdAt: '2026-01-01T10:00:01.000Z' },
    ];
    const thread = mergeThread(sent, inbox, '2026-01-01T09:30:00.000Z');
    expect(thread.map((e) => e.body)).toEqual(['BAL', 'Balance ETB 5']);
    expect(thread.map((e) => e.direction)).toEqual(['out', 'in']);
  });
  it('puts the text before a reply with the same time', () => {
    const at = '2026-01-01T10:00:00.000Z';
    const thread = mergeThread(
      [{ direction: 'out', body: 'HELP', at }],
      [{ body: 'reply', createdAt: at }],
      at,
    );
    expect(thread[0]?.direction).toBe('out');
  });
});

describe('ussd', () => {
  it('reads CON and END answers only', () => {
    expect(parseUssdResponse('CON 1 Bet\n2 Balance')).toEqual({
      kind: 'CON',
      body: '1 Bet\n2 Balance',
    });
    expect(parseUssdResponse('END Bye')).toEqual({ kind: 'END', body: 'Bye' });
    expect(parseUssdResponse('Bye')).toBeNull();
    expect(parseUssdResponse('CONX y')).toBeNull();
  });
  it('builds the star-joined history without star, hash or blanks', () => {
    expect(cleanUssdInput(' 1*2# ')).toBe('12');
    expect(appendUssdInput('', '1')).toBe('1');
    expect(appendUssdInput('1', '123')).toBe('1*123');
    expect(appendUssdInput('1*123', '  ')).toBe('1*123');
    expect(appendUssdInput('1', '00')).toBe('1*00');
  });
  it('recognises the service code dial', () => {
    expect(isServiceCodeDial(' *123# ', '*123#')).toBe(true);
    expect(isServiceCodeDial('*124#', '*123#')).toBe(false);
  });
});
