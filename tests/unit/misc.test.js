import { getCsv } from '../../src/util/misc/misc.js';

describe('getCsv', () => {
  const options = {
    fieldSeparator: ',',
    lineSeparator: '\n',
    quoteChar: '"',
  };

  test('value with no special chars is unquoted', () => {
    expect(getCsv([['plain']], options)).toBe('plain');
  });

  test('value with comma is quoted', () => {
    expect(getCsv([['a,b']], options)).toBe('"a,b"');
  });

  test('value with newline is quoted', () => {
    expect(getCsv([['line1\nline2']], options)).toBe('"line1\nline2"');
  });

  test('value with quotes is escaped and quoted', () => {
    expect(getCsv([["say \"hi\""]], options)).toBe('"say ""hi"""');
  });

  test('null and undefined values are handled in output', () => {
    expect(getCsv([['x', null, undefined]], options)).toBe('x,,');
  });

  test('numbers are converted to strings by join', () => {
    expect(getCsv([[42, 3.5]], options)).toBe('42,3.5');
  });
});
