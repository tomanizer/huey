/**
 * Unit tests for SQLHelper DATE and TIMESTAMP formatters.
 * Ensures string dates and invalid dates from remote API do not throw (e.g. RangeError: Invalid time value).
 */
vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      return key === 'localeSettings'
        ? { locale: ['en-GB'], nullString: 'NULL' }
        : {};
    },
  },
}));

import { dataTypes, createTimestampFormatter, createNumberFormatter } from '../../src/util/sql/SQLHelper.js';

describe('SQLHelper DATE formatter', () => {
  test('formats ISO date string without throwing', () => {
    const info = dataTypes['DATE'];
    const formatter = info.createFormatter();
    expect(formatter('2026-03-01')).toBeDefined();
    expect(typeof formatter('2026-03-01')).toBe('string');
  });

  test('returns null string for null', () => {
    const info = dataTypes['DATE'];
    const formatter = info.createFormatter();
    expect(formatter(null)).toBe('NULL');
  });

  test('returns null string for undefined', () => {
    const info = dataTypes['DATE'];
    const formatter = info.createFormatter();
    expect(formatter(undefined)).toBe('NULL');
  });

  test('returns string value for invalid date (no RangeError)', () => {
    const info = dataTypes['DATE'];
    const formatter = info.createFormatter();
    expect(() => formatter('not-a-date')).not.toThrow();
    expect(formatter('not-a-date')).toBe('not-a-date');
  });

  test('formats Date instance', () => {
    const info = dataTypes['DATE'];
    const formatter = info.createFormatter();
    const d = new Date('2026-03-01T00:00:00Z');
    expect(formatter(d)).toBeDefined();
    expect(typeof formatter(d)).toBe('string');
  });
});

describe('SQLHelper TIMESTAMP formatter (createTimestampFormatter)', () => {
  test('returns null string for null', () => {
    const formatter = createTimestampFormatter(false);
    expect(formatter(null)).toBe('NULL');
  });

  test('returns string value for invalid date (no RangeError)', () => {
    const formatter = createTimestampFormatter(false);
    expect(() => formatter('invalid')).not.toThrow();
    expect(formatter('invalid')).toBe('invalid');
  });

  test('formats valid timestamp value', () => {
    const formatter = createTimestampFormatter(false);
    const result = formatter(1741219200000); // 2026-03-05 00:00:00 UTC
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

describe('SQLHelper number formatter (createNumberFormatter)', () => {
  test('does not throw when field is undefined (e.g. remote cell value field)', () => {
    const { format } = createNumberFormatter(false);
    expect(() => format('1500', undefined)).not.toThrow();
    expect(format('1500', undefined)).toBe('1500');
  });

  test('does not throw when field has no type (remote path)', () => {
    const { format } = createNumberFormatter(false);
    const fieldWithoutType = { name: 'SUM(volume)' };
    expect(() => format('1500', fieldWithoutType)).not.toThrow();
    expect(format('1500', fieldWithoutType)).toBe('1500');
  });

  test('does not throw when field.type is null', () => {
    const { format } = createNumberFormatter(false);
    expect(() => format('99', { name: 'x', type: null })).not.toThrow();
    expect(format('99', { name: 'x', type: null })).toBe('99');
  });

  test('formats number when field has type with typeId', () => {
    const { format } = createNumberFormatter(false);
    const result = format(1500, { name: 'volume', type: { typeId: -5 } });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});
