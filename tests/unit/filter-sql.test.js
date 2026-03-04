vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      const defaults = {
        sqlSettings: { alwaysQuoteIdentifiers: false, keywordLetterCase: 'upperCase', commaStyle: 'newlineBefore' },
        localeSettings: { nullString: 'NULL', locale: ['en-US'], minimumIntegerDigits: 1, minimumFractionDigits: 0, maximumFractionDigits: 3, linkMinimumAndMaximumDecimals: false, nullsSortOrder: { value: 'FIRST' } },
        querySettings: { autoRunQuery: true, filterValuePicklistPageSize: 100, filterSearchAutoWildcards: false, filterSearchApplyAll: false, autoRunQueryTimeout: 1000 },
        filterDialogSettings: { filterSearchApplyAll: false, filterSearchAutoWildcards: false },
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
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';

describe('QueryAxisItem.getFilterConditionSql', () => {
  function createFilterItem(overrides) {
    return Object.assign(
      {
        columnName: 'symbol',
        columnType: 'VARCHAR',
        filter: {
          filterType: FilterDialog.filterTypes.INCLUDE,
          values: {},
        },
      },
      overrides
    );
  }

  test('INCLUDE single value generates = condition', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { AAPL: { literal: "'AAPL'", label: 'AAPL', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain("= 'AAPL'");
  });

  test('INCLUDE multiple values generates IN condition', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: {
          AAPL: { literal: "'AAPL'", label: 'AAPL', enabled: true },
          GOOG: { literal: "'GOOG'", label: 'GOOG', enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('IN');
    expect(sql).toContain("'GOOG'");
  });

  test('EXCLUDE generates NOT IN condition', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.EXCLUDE,
        values: {
          MSFT: { literal: "'MSFT'", label: 'MSFT', enabled: true },
          IBM: { literal: "'IBM'", label: 'IBM', enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('NOT IN');
    expect(sql).toContain('IS NULL');
  });

  test('LIKE generates LIKE condition', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.LIKE,
        values: { prefix: { literal: "'A%'", label: 'A%', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain("LIKE 'A%'");
  });

  test('NOT LIKE generates NOT LIKE with NULL handling', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.NOTLIKE,
        values: { pattern: { literal: "'A%'", label: 'A%', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('NOT LIKE');
    expect(sql).toContain('IS NULL');
  });

  test('BETWEEN generates BETWEEN condition', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.BETWEEN,
        values: { low: { literal: "'2020-01-01'", label: 'from', enabled: true } },
        toValues: { low: { literal: "'2020-12-31'", label: 'to', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('BETWEEN');
    expect(sql).toContain('AND');
  });

  test('NULL value in INCLUDE generates IS NULL', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { null: { literal: 'NULL', label: 'NULL', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('IS NULL');
    expect(sql).not.toContain('IN');
  });

  test('NULL value in EXCLUDE generates IS NOT NULL', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.EXCLUDE,
        values: { null: { literal: 'NULL', label: 'NULL', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('IS NOT NULL');
  });

  test('HAS ANY generates list_has_any', () => {
    const item = createFilterItem({
      columnType: 'INTEGER[]',
      filter: {
        filterType: FilterDialog.filterTypes.HASANY,
        values: {
          one: { literal: '1', label: '1', enabled: true },
          two: { literal: '2', label: '2', enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('list_has_any');
    expect(sql).toContain('[ 1,2 ]');
  });

  test('HAS ALL generates list_has_all', () => {
    const item = createFilterItem({
      columnType: 'INTEGER[]',
      filter: {
        filterType: FilterDialog.filterTypes.HASALL,
        values: {
          one: { literal: '1', label: '1', enabled: true },
          two: { literal: '2', label: '2', enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('list_has_all');
  });

  test('case insensitive adds COLLATE NOCASE', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        caseSensitive: false,
        values: { val: { literal: "'abc'", label: 'abc', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('COLLATE NOCASE');
  });

  test('disabled values are excluded', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { val: { literal: "'abc'", label: 'abc', enabled: false } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toBeUndefined();
  });

  test('empty filter returns undefined', () => {
    const item = createFilterItem();
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toBeUndefined();
  });
});
