import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  matchPspStatement,
  parseCsvRows,
  parsePspStatementCsv,
  type PspRecord,
  type PspStatementLine,
} from './pspstatement';

describe('parseCsvRows', () => {
  it('reads quoted fields, doubled quotes and both line ends', () => {
    expect(parseCsvRows('a,b\r\n"x,1","say ""hi"""\n﻿z,\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
      ['﻿z', ''],
    ]);
    expect(parseCsvRows('﻿a,b')).toEqual([['a', 'b']]);
    expect(() => parseCsvRows('"open')).toThrow(SyntaxError);
  });

  it('round-trips any table written with quoting (property)', () => {
    const cell = fc.string({ maxLength: 12 });
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 8 }),
        (rows) => {
          const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
          const text = rows.map((row) => row.map(quote).join(',')).join('\r\n');
          expect(parseCsvRows(text)).toEqual(rows);
        },
      ),
    );
  });
});

describe('parsePspStatementCsv', () => {
  it('parses amounts in birr, dates and types', () => {
    const csv = [
      'Reference,Provider,Amount,Date,Type',
      'R1,chapa,1250.50,2026-10-17,deposit',
      'R2,Chapa,"-1,000",2026-10-17T23:30:00+03:00,payout',
      'R3,chapa,10,2026-10-17T22:30:00Z,',
      '',
    ].join('\n');
    const { lines, errors } = parsePspStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      {
        lineNo: 2,
        provider: 'chapa',
        reference: 'R1',
        amount: 125050n,
        date: '2026-10-17',
        kind: 'deposit',
      },
      {
        lineNo: 3,
        provider: 'chapa',
        reference: 'R2',
        amount: -100000n,
        date: '2026-10-17',
        kind: 'payout',
      },
      // 22:30 UTC is the next business day in Addis Ababa.
      {
        lineNo: 4,
        provider: 'chapa',
        reference: 'R3',
        amount: 1000n,
        date: '2026-10-18',
        kind: null,
      },
    ]);
  });

  it('reports every bad line with its number', () => {
    const csv = [
      'provider,reference,amount,date',
      'chapa,R1,12.345,2026-10-17',
      'chapa,,10,2026-10-17',
      'Not A Provider!,R3,10,2026-10-17',
      'chapa,R4,0,2026-10-17',
      'chapa,R5,10,2026-02-30',
      'chapa,R6,10,2026-10-17',
    ].join('\n');
    const { lines, errors } = parsePspStatementCsv(csv);
    expect(lines.map((line) => line.reference)).toEqual(['R6']);
    expect(errors.map((error) => error.lineNo)).toEqual([2, 3, 4, 5, 6]);
    expect(errors[0]?.message).toMatch(/amount/);
    expect(parsePspStatementCsv('provider,reference,amount\nx,y,1').errors[0]?.message).toMatch(
      /missing column\(s\): date/,
    );
    expect(parsePspStatementCsv('').errors).toHaveLength(1);
    expect(parsePspStatementCsv('provider,reference,amount,date\n').errors[0]?.message).toMatch(
      /no lines/,
    );
    expect(
      parsePspStatementCsv('provider,reference,amount,date,type\nchapa,R,-5,2026-10-17,deposit')
        .errors[0]?.message,
    ).toMatch(/deposit amount must be positive/);
    const many = ['provider,reference,amount,date', 'chapa,A,1,2026-10-17', 'chapa,B,1,2026-10-17'];
    expect(parsePspStatementCsv(many.join('\n'), { maxLines: 1 }).errors[0]?.message).toMatch(
      /more than 1 lines/,
    );
  });
});

const record = (overrides: Partial<PspRecord> & Pick<PspRecord, 'id'>): PspRecord => ({
  kind: 'deposit',
  provider: 'chapa',
  reference: `REF-${overrides.id}`,
  amount: 100_00n,
  settled: true,
  status: 'succeeded',
  date: '2026-10-17',
  ...overrides,
});
const line = (
  lineNo: number,
  overrides: Partial<PspStatementLine> & Pick<PspStatementLine, 'reference'>,
): PspStatementLine => ({
  lineNo,
  provider: 'chapa',
  amount: 100_00n,
  date: '2026-10-17',
  kind: null,
  ...overrides,
});
const PERIOD = { from: '2026-10-17', to: '2026-10-17' };

describe('matchPspStatement', () => {
  it('matches each line to exactly one record and lists the records no line matched', () => {
    const records = [
      record({ id: 'd1' }),
      record({ id: 'd2', amount: 50_00n }),
      record({ id: 'd3', settled: false, status: 'failed' }),
      record({ id: 'p1', kind: 'payout', status: 'paid', amount: 70_00n }),
      record({ id: 'p2', kind: 'payout', status: 'paid', amount: 30_00n }),
      // Settled outside the period: not missing.
      record({ id: 'd4', date: '2026-10-16' }),
      record({ id: 'd5', reference: null, settled: false, status: 'pending', date: null }),
    ];
    const result = matchPspStatement({
      lines: [
        line(2, { reference: 'REF-d1' }),
        line(3, { reference: 'REF-d2', amount: 51_00n }),
        line(4, { reference: 'REF-d3' }),
        line(5, { reference: 'REF-p1', amount: -70_00n }),
        line(6, { reference: 'REF-zz' }),
        line(7, { reference: 'REF-d1' }),
      ],
      records,
      period: PERIOD,
    });
    expect(result.lines.map((match) => [match.lineNo, match.status, match.recordId])).toEqual([
      [2, 'matched', 'd1'],
      [3, 'amount_mismatch', 'd2'],
      [4, 'status_mismatch', 'd3'],
      [5, 'matched', 'p1'],
      [6, 'unmatched', null],
      [7, 'duplicate', null],
    ]);
    expect(result.missing.map((missing) => missing.id)).toEqual(['p2']);
  });

  it('tells deposits and payouts with the same reference apart by type or sign', () => {
    const records = [
      record({ id: 'd', reference: 'SAME' }),
      record({ id: 'p', kind: 'payout', reference: 'SAME', status: 'paid' }),
    ];
    const lines = [
      line(2, { reference: 'SAME', kind: 'deposit' }),
      line(3, { reference: 'SAME', amount: -100_00n }),
      line(4, { reference: 'SAME' }),
    ];
    const result = matchPspStatement({ lines, records, period: PERIOD });
    expect(result.lines.map((match) => match.status)).toEqual(['matched', 'matched', 'ambiguous']);
    expect(result.missing).toEqual([]);
  });

  it('is clean exactly when lines and settled records pair up one to one (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1_000 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 3 }),
        (ids, defect) => {
          const records = ids.map((id) =>
            record({
              id: `r${id}`,
              amount: BigInt(id) * 100n,
              kind: id % 2 ? 'deposit' : 'payout',
            }),
          );
          const lines = records.map((r, i) =>
            line(i + 2, {
              reference: r.reference!,
              amount: r.kind === 'payout' ? -r.amount : r.amount,
            }),
          );
          if (records.length > 0 && defect === 1)
            lines[0] = { ...lines[0]!, amount: lines[0]!.amount + 1n };
          if (records.length > 0 && defect === 2) lines.pop();
          if (defect === 3) lines.push(line(999, { reference: 'UNKNOWN' }));
          const result = matchPspStatement({ lines, records, period: PERIOD });
          const clean =
            result.missing.length === 0 &&
            result.lines.every((match) => match.status === 'matched');
          expect(clean).toBe(defect === 0 || (records.length === 0 && defect !== 3));
        },
      ),
    );
  });
});
