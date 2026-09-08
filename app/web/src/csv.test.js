import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvLine } from './csv';

describe('parseCsvLine', () => {
  it('splits plain comma-delimited cells', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvLine('')).toEqual(['']);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseCsvLine('"Smith, Jane",42')).toEqual(['Smith, Jane', '42']);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    expect(parseCsvLine('"She said ""hi""",ok')).toEqual(['She said "hi"', 'ok']);
  });
});

describe('parseCsv', () => {
  it('handles a header plus rows, CRLF and LF line endings, and skips blank lines', () => {
    const text = 'name,email\r\nJamie,jamie@example.test\n\nAlex,alex@example.test\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'email'],
      ['Jamie', 'jamie@example.test'],
      ['Alex', 'alex@example.test'],
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});
