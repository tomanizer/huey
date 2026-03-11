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
      rows: [{}],
      columns: [{}],
      cells: [{
        row: 0,
        col: 0,
        sales_sum: 42,
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

  test('builds a valid local cells query when rows exist and the columns axis is empty', async () => {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { CellSet } = await import('../../src/DataSet/CellSet.js');

    const rowItem = {
      axis: queryModelModule.QueryModel.AXIS_ROWS,
      columnName: '#',
      columnType: 'USMALLINT',
    };
    const measureItem = {
      axis: queryModelModule.QueryModel.AXIS_CELLS,
      columnName: 'column_name',
      columnType: 'VARCHAR',
      aggregator: 'min',
      caption: 'Column Name',
    };

    const query = vi.fn().mockResolvedValue({
      numRows: 1,
      schema: {
        fields: [
          { name: '__huey_cellIndex' },
          { name: 'MIN( "__data"."column_name" )', type: { typeId: 5 } },
        ],
      },
      get() {
        return {
          __huey_cellIndex: 0,
          'MIN( "__data"."column_name" )': 'id',
        };
      },
    });

    const datasource = {
      getType() {
        return 'file';
      },
      getManagedConnection() {
        return { query };
      },
      getFromClauseSql() {
        return 'FROM test_relation';
      },
    };

    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getCellsAxis() {
        return { getItems: () => [measureItem] };
      },
      getRowsAxis() {
        return { getItems: () => [rowItem] };
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

    const rowsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync() {
        return { values: [1] };
      },
      getTupleValueFields() {
        return [{ name: '#', type: { typeId: 5 } }];
      },
      getQueryAxisItems() {
        return [rowItem];
      },
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 0;
      },
      getTupleSync() {
        return undefined;
      },
      getTupleValueFields() {
        return [];
      },
      getQueryAxisItems() {
        return [];
      },
    };

    const cellSet = new CellSet(queryModel, [rowsTupleSet, columnsTupleSet], createSettings());
    const cells = await cellSet.getCells([[0, 1], [0, 0]]);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(', __huey_tuples(\n  __huey_cellIndex\n, "#"');
    expect(sql).toContain('ON  __huey_tuples."#" is not distinct from __huey_cells."#"');
    expect(Object.values(cells[0].values)).toEqual(['id']);
  });

  test('keeps tuple relation columns when one axis tuple is missing', async () => {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { CellSet } = await import('../../src/DataSet/CellSet.js');

    const rowItem = {
      axis: queryModelModule.QueryModel.AXIS_ROWS,
      columnName: '#',
      columnType: 'USMALLINT',
    };
    const measureItem = {
      axis: queryModelModule.QueryModel.AXIS_CELLS,
      columnName: 'column_name',
      columnType: 'VARCHAR',
      aggregator: 'min',
      caption: 'Column Name',
    };

    const query = vi.fn().mockResolvedValue({
      numRows: 1,
      schema: {
        fields: [
          { name: '__huey_cellIndex' },
          { name: 'MIN( "__data"."column_name" )', type: { typeId: 5 } },
        ],
      },
      get() {
        return {
          __huey_cellIndex: 0,
          'MIN( "__data"."column_name" )': 'id',
        };
      },
    });

    const datasource = {
      getType() {
        return 'file';
      },
      getManagedConnection() {
        return { query };
      },
      getFromClauseSql() {
        return 'FROM test_relation';
      },
    };

    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getCellsAxis() {
        return { getItems: () => [measureItem] };
      },
      getRowsAxis() {
        return { getItems: () => [rowItem] };
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

    const rowsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync() {
        return { values: [1] };
      },
      getTupleValueFields() {
        return [{ name: '#', type: { typeId: 5 } }];
      },
      getQueryAxisItems() {
        return [rowItem];
      },
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync() {
        return undefined;
      },
      getTupleValueFields() {
        return [];
      },
      getQueryAxisItems() {
        return [];
      },
    };

    const cellSet = new CellSet(queryModel, [rowsTupleSet, columnsTupleSet], createSettings());
    await cellSet.getCells([[0, 1], [0, 1]]);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(', __huey_tuples(\n  __huey_cellIndex\n, "#"');
    expect(sql).not.toContain(', __huey_tuples(\n  __huey_cellIndex\n) AS');
  });

  test('preloads missing row tuples before building the local cells query', async () => {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { CellSet } = await import('../../src/DataSet/CellSet.js');

    const rowItem = {
      axis: queryModelModule.QueryModel.AXIS_ROWS,
      columnName: '#',
      columnType: 'USMALLINT',
    };
    const measureItem = {
      axis: queryModelModule.QueryModel.AXIS_CELLS,
      columnName: 'column_name',
      columnType: 'VARCHAR',
      aggregator: 'min',
      caption: 'Column Name',
    };

    const query = vi.fn().mockResolvedValue({
      numRows: 1,
      schema: {
        fields: [
          { name: '__huey_cellIndex' },
          { name: 'MIN( "__data"."column_name" )', type: { typeId: 5 } },
        ],
      },
      get() {
        return {
          __huey_cellIndex: 0,
          'MIN( "__data"."column_name" )': 'id',
        };
      },
    });

    const datasource = {
      getType() {
        return 'file';
      },
      getManagedConnection() {
        return { query };
      },
      getFromClauseSql() {
        return 'FROM test_relation';
      },
    };

    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getCellsAxis() {
        return { getItems: () => [measureItem] };
      },
      getRowsAxis() {
        return { getItems: () => [rowItem] };
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

    let rowLoaded = false;
    const rowsTupleSet = {
      getTupleCountSync() {
        return rowLoaded ? 1 : undefined;
      },
      getTupleSync() {
        return rowLoaded ? { values: [1] } : undefined;
      },
      getTupleValueFields() {
        return [{ name: '#', type: { typeId: 5 } }];
      },
      getQueryAxisItems() {
        return [rowItem];
      },
      getTuples: vi.fn(async () => {
        rowLoaded = true;
        return [{ values: [1] }];
      }),
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 0;
      },
      getTupleSync() {
        return undefined;
      },
      getTupleValueFields() {
        return [];
      },
      getQueryAxisItems() {
        return [];
      },
      getTuples: vi.fn(async () => []),
    };

    const cellSet = new CellSet(queryModel, [rowsTupleSet, columnsTupleSet], createSettings());
    await cellSet.getCells([[0, 1], [0, 1]]);

    expect(rowsTupleSet.getTuples).toHaveBeenCalledWith(1, 0);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('(0, 1)');
    expect(sql).not.toContain('(0, NULL)');
  });

  test('preloads requested tuple ranges even when tuple count is already known', async () => {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { CellSet } = await import('../../src/DataSet/CellSet.js');

    const rowItem = {
      axis: queryModelModule.QueryModel.AXIS_ROWS,
      columnName: '#',
      columnType: 'USMALLINT',
    };
    const measureItem = {
      axis: queryModelModule.QueryModel.AXIS_CELLS,
      columnName: 'column_name',
      columnType: 'VARCHAR',
      aggregator: 'min',
      caption: 'Column Name',
    };

    const query = vi.fn().mockResolvedValue({
      numRows: 1,
      schema: {
        fields: [
          { name: '__huey_cellIndex' },
          { name: 'MIN( "__data"."column_name" )', type: { typeId: 5 } },
        ],
      },
      get() {
        return {
          __huey_cellIndex: 0,
          'MIN( "__data"."column_name" )': 'id',
        };
      },
    });

    const datasource = {
      getType() {
        return 'file';
      },
      getManagedConnection() {
        return { query };
      },
      getFromClauseSql() {
        return 'FROM test_relation';
      },
    };

    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getCellsAxis() {
        return { getItems: () => [measureItem] };
      },
      getRowsAxis() {
        return { getItems: () => [rowItem] };
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

    let loadedRange;
    const rowsTupleSet = {
      getTupleCountSync() {
        return 25;
      },
      getTupleSync(index) {
        if (loadedRange && index >= loadedRange[0] && index < loadedRange[1]) {
          return { values: [index + 1] };
        }
        return undefined;
      },
      getTupleValueFields() {
        return [{ name: '#', type: { typeId: 5 } }];
      },
      getQueryAxisItems() {
        return [rowItem];
      },
      getTuples: vi.fn(async (count, from) => {
        loadedRange = [from, from + count];
        return Array.from({ length: count }, (_value, idx) => ({ values: [from + idx + 1] }));
      }),
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 0;
      },
      getTupleSync() {
        return undefined;
      },
      getTupleValueFields() {
        return [];
      },
      getQueryAxisItems() {
        return [];
      },
      getTuples: vi.fn(async () => []),
    };

    const cellSet = new CellSet(queryModel, [rowsTupleSet, columnsTupleSet], createSettings());
    await cellSet.getCells([[0, 25], [0, 1]]);

    expect(rowsTupleSet.getTuples).toHaveBeenCalledWith(25, 0);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('(0, 1)');
    expect(sql).toContain('(24, 25)');
  });
});
