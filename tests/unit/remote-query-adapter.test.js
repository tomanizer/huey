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

  test('maps include filter to lowercase include with enabled values only', () => {
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
        operator: 'include',
        values: ['AAPL'],
      },
    ]);
  });

  test('maps notin filter to lowercase exclude', () => {
    const filters = RemoteQueryAdapter.toRemoteFilters([
      makeFilterAxisItem('symbol', {
        filterType: FilterDialog.filterTypes.EXCLUDE,
        values: {
          TSLA: { value: 'TSLA', enabled: true },
        },
      }),
    ], 'test');

    expect(filters[0].operator).toBe('exclude');
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
        operator: 'between',
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

  test('builds cells query with normalized lowercase aggregation ids', () => {
    const queryModel = {
      getRowsAxis: () => ({ getItems: () => [{ columnName: 'symbol' }] }),
      getColumnsAxis: () => ({ getItems: () => [{ columnName: 'exchange' }] }),
      getFiltersAxis: () => ({ getItems: () => [] }),
    };

    const query = RemoteQueryAdapter.createRemoteCellsQuery(queryModel, 10, 5, [
      { columnName: 'volume', aggregator: 'sum' },
      { columnName: 'volume', aggregator: 'avg' },
    ]);

    expect(query.axes.measures[0].aggregation).toBe('sum');
    expect(query.axes.measures[1].aggregation).toBe('avg');
    expect(query.axes.measures[0].alias).not.toBe(query.axes.measures[1].alias);
  });

  test('maps extended aggregator names to API ids', () => {
    const queryModel = {
      getRowsAxis: () => ({ getItems: () => [] }),
      getColumnsAxis: () => ({ getItems: () => [] }),
      getFiltersAxis: () => ({ getItems: () => [] }),
    };

    const query = RemoteQueryAdapter.createRemoteCellsQuery(queryModel, 1, 1, [
      { columnName: 'volume', aggregator: 'distinct count' },
      { columnName: 'flag', aggregator: 'count if true' },
      { columnName: 'symbol', aggregator: 'unique values' },
      { columnName: 'volume', aggregator: 'histogram' },
    ]);

    expect(query.axes.measures.map((measure) => measure.aggregation)).toEqual([
      'distinct_count',
      'count_if_true',
      'unique_list',
      'histogram'
    ]);
  });

  test('throws on unknown aggregator name', () => {
    const queryModel = {
      getRowsAxis: () => ({ getItems: () => [] }),
      getColumnsAxis: () => ({ getItems: () => [] }),
      getFiltersAxis: () => ({ getItems: () => [] }),
    };

    expect(() => {
      RemoteQueryAdapter.createRemoteCellsQuery(queryModel, 1, 1, [
        { columnName: 'volume', aggregator: 'some unknown aggregator' },
      ]);
    }).toThrow('does not support aggregator');
  });

  test('returns undefined when query model has no date range', () => {
    const dateRange = RemoteQueryAdapter.getDateRange({});
    expect(dateRange).toBeUndefined();
  });
});
