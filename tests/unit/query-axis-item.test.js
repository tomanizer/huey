vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      const defaults = {
        sqlSettings: { alwaysQuoteIdentifiers: false, keywordLetterCase: 'upperCase', commaStyle: 'newlineBefore' },
        localeSettings: { nullString: 'NULL', locale: ['en-US'], minimumIntegerDigits: 1, minimumFractionDigits: 0, maximumFractionDigits: 3, linkMinimumAndMaximumDecimals: false, nullsSortOrder: { value: 'FIRST' } },
      };
      return defaults[key] || {};
    },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn(),
}));

import { QueryAxisItem } from '../../src/QueryModel/QueryModel.js';

describe('QueryAxisItem.getSqlForQueryAxisItem', () => {
  test('simple column returns qualified identifier', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem({
      columnName: 'city',
      columnType: 'VARCHAR',
    });
    expect(sql).toBe('city');
  });

  test('column with derivation wraps in expression', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'order_date',
        columnType: 'DATE',
        derivation: 'year',
      },
      't'
    );
    expect(sql).toContain('YEAR( t.order_date )');
  });

  test('column with aggregator wraps in aggregation', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'revenue',
        columnType: 'DOUBLE',
        aggregator: 'sum',
      },
      'f'
    );
    expect(sql).toContain('SUM');
    expect(sql).toContain('f.revenue');
  });

  test('column with both derivation and aggregation', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'order_date',
        columnType: 'DATE',
        derivation: 'year',
        aggregator: 'count',
      },
      'fact'
    );
    expect(sql).toContain('COUNT');
    expect(sql).toContain('YEAR(');
  });
});
