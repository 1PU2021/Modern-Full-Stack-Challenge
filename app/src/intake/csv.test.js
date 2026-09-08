'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseCsvLine } = require('./csv');

test('parseCsvLine splits plain comma-delimited cells', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine(''), ['']);
});

test('parseCsvLine handles quoted fields containing commas', () => {
  assert.deepEqual(parseCsvLine('"Smith, Jane",42'), ['Smith, Jane', '42']);
});

test('parseCsvLine handles escaped double quotes inside quoted fields', () => {
  assert.deepEqual(parseCsvLine('"She said ""hi""",ok'), ['She said "hi"', 'ok']);
});

test('parseCsv handles a header plus rows, CRLF and LF line endings, and skips blank lines', () => {
  const text = 'name,email\r\nJamie,jamie@example.test\n\nAlex,alex@example.test\r\n';
  assert.deepEqual(parseCsv(text), [
    ['name', 'email'],
    ['Jamie', 'jamie@example.test'],
    ['Alex', 'alex@example.test'],
  ]);
});

test('parseCsv returns an empty array for empty input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
});
