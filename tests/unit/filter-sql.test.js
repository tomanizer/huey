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

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

import { QueryAxisItem } from '../../src/QueryModel/QueryModel.js';
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';
import { getDataTypeInfo } from '../../src/util/sql/SQLHelper.js';

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

  test('NOT BETWEEN generates NOT BETWEEN condition with null handling', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.NOTBETWEEN,
        values: {
          low: { literal: "'2021-01-01'", label: 'from', enabled: true },
          null: { literal: 'NULL', label: 'NULL', enabled: true },
        },
        toValues: {
          low: { literal: "'2021-12-31'", label: 'to', enabled: true },
          null: { literal: 'NULL', label: 'NULL', enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('NOT BETWEEN');
    expect(sql).toContain('IS NOT NULL');
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

  test('LIKE preserves special characters and escaped quotes', () => {
    const item = createFilterItem({
      filter: {
        filterType: FilterDialog.filterTypes.LIKE,
        values: {
          special: { literal: "'100%_O''Reilly'", label: "100%_O'Reilly", enabled: true },
        },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain("LIKE '100%_O''Reilly'");
  });

  test('derived expression uses derivation SQL in filter condition', () => {
    const item = createFilterItem({
      columnName: 'order_date',
      columnType: 'DATE',
      derivation: 'year',
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { y2024: { literal: '2024', label: '2024', enabled: true } },
      },
    });
    const sql = QueryAxisItem.getFilterConditionSql(item);
    expect(sql).toContain('YEAR(');
    expect(sql).toContain('= 2024');
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

  test('getCaptionForQueryAxisItem returns filter caption text', () => {
    const item = createFilterItem({
      axis: 'filters',
      filter: {
        filterType: FilterDialog.filterTypes.BETWEEN,
        values: { low: { literal: '1', label: '1', enabled: true } },
        toValues: { low: { literal: '10', label: '10', enabled: true } },
      },
    });
    const caption = QueryAxisItem.getCaptionForQueryAxisItem(item);
    expect(caption).toContain('between');
    expect(caption).toContain('1 - 10');
  });
});

describe('QueryAxisItem derivation helpers', () => {
  test('getDerivationCaption returns known and unknown captions', () => {
    expect(QueryAxisItem.getDerivationCaption('year')).toBe('year');
    expect(QueryAxisItem.getDerivationCaption('unknown-derivation')).toBe('unknown-derivation');
  });

  test('getAvailableDerivations returns subset by datatype info', () => {
    expect(QueryAxisItem.getAvailableDerivations()).toEqual({});

    const numeric = QueryAxisItem.getAvailableDerivations(getDataTypeInfo('INTEGER'));
    expect(Object.keys(numeric)).toHaveLength(0);

    const date = QueryAxisItem.getAvailableDerivations(getDataTypeInfo('DATE'));
    expect(date.year).toBeDefined();
    expect(date.hour).toBeUndefined();
    expect(date.uppercase).toBeUndefined();

    const str = QueryAxisItem.getAvailableDerivations(getDataTypeInfo('VARCHAR'));
    expect(str.uppercase).toBeDefined();
    expect(str['md5 (hex)']).toBeDefined();

    const json = QueryAxisItem.getAvailableDerivations(getDataTypeInfo('JSON'));
    expect(json.hash).toBeDefined();
    expect(json['md5 (hex)']).toBeDefined();

    const arr = QueryAxisItem.getAvailableDerivations(getDataTypeInfo('ARRAY'));
    expect(arr.hash).toBeDefined();
    expect(arr['md5 (hex)']).toBeUndefined();
  });
});
