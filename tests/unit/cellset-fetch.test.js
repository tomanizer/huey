import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/DataSource/remote/RemoteQueryAdapter.js', () => ({
  RemoteQueryAdapter: {
    createRemoteCellsQuery: vi.fn(() => ({
      columns: { count: 1 },
      axes: {
        rows: [],
        columns: [],
        measures: [{ alias: 'sales_sum' }],
      },
    })),
    getDateRange: vi.fn(() => undefined),
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DOUBLE_TYPE_ID = -12;

function createSettings(overrides) {
  const querySettings = Object.assign({
    cellSetMaxCacheEntries: 1000,
    cellSetMaxCacheSizeMb: 50,
  }, overrides || {});
  return {
    getSettings(path) {
      if (Array.isArray(path) && path[0] === 'querySettings') {
        return querySettings[path[1]];
      }
      return undefined;
    },
  };
}

function createTupleSet() {
  return {
    getTupleCountSync() {
      return 1;
    },
    getTupleSync() {
      return { values: [] };
    },
    getTupleValueFields() {
      return [];
    },
    getQueryAxisItems() {
      return [];
    },
  };
}

describe('CellSet cell fetching flows', () => {
  test('returns undefined when there are no requested cell axis items', async () => {
    const { CellSet } = await import('../../src/DataSet/CellSet.js');
    const queryModel = {
      getDatasource() {
        return null;
      },
      getCellsAxis() {
        return { getItems: () => [] };
      },
    };

    const cellSet = new CellSet(queryModel, [createTupleSet(), createTupleSet()], createSettings());

    await expect(cellSet.getCells([[0, 1], [0, 1]])).resolves.toBeUndefined();
  });

  test('queries missing cells once, caches them, and tracks returned field metadata', async () => {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { CellSet } = await import('../../src/DataSet/CellSet.js');

    const measureItem = {
      axis: queryModelModule.QueryModel.AXIS_CELLS,
      columnName: 'sales',
      columnType: 'DOUBLE',
      aggregator: 'sum',
    };
    const measureSql = queryModelModule.QueryAxisItem.getSqlForQueryAxisItem(measureItem, CellSet.datasetRelationName);

    const fetchCells = vi.fn().mockResolvedValue({
      cells: [{
        row_index: 0,
        column_index: 0,
        values: {
          0: 42,
        },
      }],
    });
    const connection = {
      fetchCells,
    };

    const queryModel = {
      getDatasource() {
        return {
          getType() {
            return 'remote';
          },
          getManagedConnection() {
            return connection;
          },
        };
      },
      getCellsAxis() {
        return { getItems: () => [measureItem] };
      },
      getRowsAxis() {
        return { getItems: () => [] };
      },
      getColumnsAxis() {
        return { getItems: () => [] };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      },
      getSampling() {
        return undefined;
      },
    };

    const cellSet = new CellSet(queryModel, [createTupleSet(), createTupleSet()], createSettings());

    const firstFetch = await cellSet.getCells([[0, 1], [0, 1]]);
    const secondFetch = await cellSet.getCells([[0, 1], [0, 1]]);

    expect(fetchCells).toHaveBeenCalledTimes(1);
    expect(firstFetch[0].values[measureSql]).toBe(42);
    expect(secondFetch[0].values[measureSql]).toBe(42);
    expect(cellSet.getCellValueFields()[measureSql].type.typeId).toBe(DOUBLE_TYPE_ID);
  });
});
