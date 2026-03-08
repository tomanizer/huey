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

import { RemoteQueryAdapter } from '../../src/DataSource/remote/RemoteQueryAdapter.js';
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';

describe('RemoteQueryAdapter', () => {
  function makeFilterAxisItem(columnName, filter) {
    return { columnName, filter };
  }

  test('maps include filter to INCLUDE with enabled values only', () => {
    const filters = RemoteQueryAdapter.toRemoteFilters([
      makeFilterAxisItem('symbol', {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: {
          AAPL: { value: 'AAPL', enabled: true },
          GOOG: { value: 'GOOG', enabled: false },
        },
      }),
    ], 'test');

    expect(filters).toEqual([
      {
        field: 'symbol',
        operator: 'INCLUDE',
        values: ['AAPL'],
      },
    ]);
  });

  test('maps notin filter to EXCLUDE', () => {
    const filters = RemoteQueryAdapter.toRemoteFilters([
      makeFilterAxisItem('symbol', {
        filterType: FilterDialog.filterTypes.EXCLUDE,
        values: {
          TSLA: { value: 'TSLA', enabled: true },
        },
      }),
    ], 'test');

    expect(filters[0].operator).toBe('EXCLUDE');
    expect(filters[0].values).toEqual(['TSLA']);
  });

  test('maps between filter to two values', () => {
    const filters = RemoteQueryAdapter.toRemoteFilters([
      makeFilterAxisItem('date', {
        filterType: FilterDialog.filterTypes.BETWEEN,
        values: {
          start: { value: '2026-01-01', enabled: true },
        },
        toValues: {
          start: { value: '2026-01-31', enabled: true },
        },
      }),
    ], 'test');

    expect(filters).toEqual([
      {
        field: 'date',
        operator: 'BETWEEN',
        values: ['2026-01-01', '2026-01-31'],
      },
    ]);
  });

  test('throws on unsupported filter type', () => {
    expect(() => {
      RemoteQueryAdapter.toRemoteFilters([
        makeFilterAxisItem('symbol', {
          filterType: FilterDialog.filterTypes.NOTLIKE,
          values: {
            a: { value: 'A%', enabled: true },
          },
        }),
      ], 'test');
    }).toThrow('does not support filter type');
  });

  test('builds cells query with uppercase aggregation names', () => {
    const queryModel = {
      getRowsAxis: () => ({ getItems: () => [{ columnName: 'symbol' }] }),
      getColumnsAxis: () => ({ getItems: () => [{ columnName: 'exchange' }] }),
      getFiltersAxis: () => ({ getItems: () => [] }),
    };

    const query = RemoteQueryAdapter.createRemoteCellsQuery(queryModel, 10, 5, [
      { columnName: 'volume', aggregator: 'sum' },
      { columnName: 'volume', aggregator: 'avg' },
    ]);

    expect(query.axes.measures[0].aggregation).toBe('SUM');
    expect(query.axes.measures[1].aggregation).toBe('AVG');
    expect(query.axes.measures[0].alias).not.toBe(query.axes.measures[1].alias);
  });

  test('throws for unsupported cell aggregator', () => {
    const queryModel = {
      getRowsAxis: () => ({ getItems: () => [] }),
      getColumnsAxis: () => ({ getItems: () => [] }),
      getFiltersAxis: () => ({ getItems: () => [] }),
    };

    expect(() => {
      RemoteQueryAdapter.createRemoteCellsQuery(queryModel, 1, 1, [
        { columnName: 'volume', aggregator: 'distinct count' },
      ]);
    }).toThrow('does not support aggregator');
  });

  test('falls back to single-date range when query model has no date range', () => {
    const dateRange = RemoteQueryAdapter.getDateRange({});
    expect(dateRange.type).toBe('single');
    expect(typeof dateRange.date).toBe('string');
    expect(dateRange.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
