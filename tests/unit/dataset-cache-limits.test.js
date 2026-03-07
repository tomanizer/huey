vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings() {
      return {};
    },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {}
  }
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn()
}));

import { TupleSet } from '../../src/DataSet/TupleSet.js';
import { CellSet } from '../../src/DataSet/CellSet.js';

function createSettings(overrides) {
  const querySettings = Object.assign({
    tupleSetMaxCacheEntries: 10000,
    tupleSetMaxCacheSizeMb: 50,
    cellSetMaxCacheEntries: 10000,
    cellSetMaxCacheSizeMb: 50
  }, overrides || {});
  return {
    getSettings(path) {
      if (!Array.isArray(path)) {
        if (path === 'querySettings') {
          return querySettings;
        }
        return undefined;
      }
      if (path[0] === 'querySettings') {
        return querySettings[path[1]];
      }
      return undefined;
    }
  };
}

describe('DataSet cache limits', () => {
  test('TupleSet evicts least-recently-used tuples when entry limit is exceeded', async () => {
    const allValues = ['A', 'B', 'C', 'D'];
    const connection = {
      fetchTuples(dateRange, query) {
        const paging = query.paging || {};
        const limit = paging.limit || allValues.length;
        const offset = paging.offset || 0;
        const items = allValues.slice(offset, offset + limit).map((value) => ({ values: [value] }));
        return { items, total_count: allValues.length };
      },
      getState() {
        return 'open';
      }
    };
    const datasource = {
      getType() {
        return 'remote';
      },
      getManagedConnection() {
        return connection;
      }
    };
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getQueryAxis() {
        return { getItems: () => axisItems };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };

    const tupleSet = new TupleSet(queryModel, 'rows', createSettings({ tupleSetMaxCacheEntries: 2 }));
    tupleSet.setPageSize(2);
    await tupleSet.getTuples(2, 0);
    await tupleSet.getTuples(2, 2);

    expect(tupleSet.getTupleSync(0)).toBeUndefined();
    expect(tupleSet.getTupleSync(1)).toBeUndefined();
    expect(tupleSet.getTupleSync(2)).toBeDefined();
    expect(tupleSet.getTupleSync(3)).toBeDefined();
    expect(tupleSet.cacheSize).toBeGreaterThan(2);

    tupleSet.clearCache();
    expect(tupleSet.getTupleSync(0)).toBeUndefined();
    expect(tupleSet.cacheSize).toBe(2);
  });

  test('TupleSet cache sizing handles BigInt tuple values without crashing', async () => {
    const connection = {
      fetchTuples(dateRange, query) {
        const paging = query.paging || {};
        const limit = paging.limit || 1;
        const offset = paging.offset || 0;
        const items = Array.from({ length: limit }, (_value, i) => ({ values: [BigInt(offset + i + 1)] }));
        return { items, total_count: 2 };
      },
      getState() {
        return 'open';
      }
    };
    const datasource = {
      getType() {
        return 'remote';
      },
      getManagedConnection() {
        return connection;
      }
    };
    const axisItems = [{ columnName: 'hugeint_field', columnType: 'HUGEINT' }];
    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getQueryAxis() {
        return { getItems: () => axisItems };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };

    const tupleSet = new TupleSet(queryModel, 'rows', createSettings({ tupleSetMaxCacheEntries: 10, tupleSetMaxCacheSizeMb: 50 }));
    tupleSet.setPageSize(2);

    await tupleSet.getTuples(2, 0);
    expect(tupleSet.getTupleSync(0)).toBeDefined();
    expect(tupleSet.cacheSize).toBeGreaterThan(2);
  });

  test('TupleSet evicts least-recently-used tuples when size limit is exceeded', async () => {
    const allValues = ['A'.repeat(20), 'B'.repeat(20), 'C'.repeat(20)];
    const connection = {
      fetchTuples(dateRange, query) {
        const paging = query.paging || {};
        const limit = paging.limit || allValues.length;
        const offset = paging.offset || 0;
        const items = allValues.slice(offset, offset + limit).map((value) => ({ values: [value] }));
        return { items, total_count: allValues.length };
      },
      getState() {
        return 'open';
      }
    };
    const datasource = {
      getType() {
        return 'remote';
      },
      getManagedConnection() {
        return connection;
      }
    };
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getQueryAxis() {
        return { getItems: () => axisItems };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };

    const maxCacheSizeMb = 0.00007;
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings({
      tupleSetMaxCacheEntries: 10,
      tupleSetMaxCacheSizeMb: maxCacheSizeMb
    }));
    tupleSet.setPageSize(3);

    await tupleSet.getTuples(3, 0);

    expect(tupleSet.getTupleSync(0)).toBeUndefined();
    expect(tupleSet.getTupleSync(1)).toBeUndefined();
    expect(tupleSet.getTupleSync(2)).toBeDefined();
    expect(tupleSet.cacheSize).toBeLessThanOrEqual(maxCacheSizeMb * 1024 * 1024);
  });

  test('CellSet evicts least-recently-used cells when entry limit is exceeded', async () => {
    let fetchCellsCallCount = 0;
    const connection = {
      fetchCells(dateRange, query) {
        fetchCellsCallCount += 1;
        const rowCount = query.rows.count || 1;
        const colCount = query.columns.count || 1;
        const cells = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          for (let columnIndex = 0; columnIndex < colCount; columnIndex++) {
            cells.push({
              row_index: rowIndex,
              column_index: columnIndex,
              values: { 2: rowIndex + columnIndex + 1 }
            });
          }
        }
        return { cells };
      },
      getState() {
        return 'open';
      }
    };
    const datasource = {
      getType() {
        return 'remote';
      },
      getManagedConnection() {
        return connection;
      }
    };
    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getRowsAxis() {
        return { getItems: () => [{ columnName: 'row_field', columnType: 'VARCHAR' }] };
      },
      getColumnsAxis() {
        return { getItems: () => [{ columnName: 'col_field', columnType: 'VARCHAR' }] };
      },
      getCellsAxis() {
        return { getItems: () => [{ columnName: 'amount', columnType: 'DOUBLE', aggregator: 'sum' }] };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };
    const tupleField = [{ name: 'value', type: { typeId: 5 } }];
    const rowsTupleSet = {
      getTupleCountSync() {
        return 3;
      },
      getTupleSync(index) {
        return { values: [index] };
      },
      getTupleValueFields() {
        return tupleField;
      },
      getQueryAxisItems() {
        return [{ columnName: 'row_field', columnType: 'VARCHAR' }];
      }
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync(index) {
        return { values: [index] };
      },
      getTupleValueFields() {
        return tupleField;
      },
      getQueryAxisItems() {
        return [{ columnName: 'col_field', columnType: 'VARCHAR' }];
      }
    };

    const cellSet = new CellSet(
      queryModel,
      [rowsTupleSet, columnsTupleSet],
      createSettings({ cellSetMaxCacheEntries: 2 })
    );

    await cellSet.getCells([[0, 3], [0, 1]]);
    expect(fetchCellsCallCount).toBe(1);

    await cellSet.getCells([[0, 1], [0, 1]]);
    expect(fetchCellsCallCount).toBe(2);
    expect(cellSet.cacheSize).toBeGreaterThan(2);

    cellSet.clearCache();
    expect(cellSet.cacheSize).toBe(2);
  });

  test('CellSet cache sizing handles BigInt cell values without crashing', async () => {
    const connection = {
      fetchCells() {
        return {
          cells: [{
            row_index: 0,
            column_index: 0,
            values: { 2: 1n }
          }]
        };
      },
      getState() {
        return 'open';
      }
    };
    const datasource = {
      getType() {
        return 'remote';
      },
      getManagedConnection() {
        return connection;
      }
    };
    const queryModel = {
      getDatasource() {
        return datasource;
      },
      getRowsAxis() {
        return { getItems: () => [{ columnName: 'row_field', columnType: 'VARCHAR' }] };
      },
      getColumnsAxis() {
        return { getItems: () => [{ columnName: 'col_field', columnType: 'VARCHAR' }] };
      },
      getCellsAxis() {
        return { getItems: () => [{ columnName: 'amount', columnType: 'HUGEINT', aggregator: 'sum' }] };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };
    const tupleField = [{ name: 'value', type: { typeId: 5 } }];
    const rowsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync(index) {
        return { values: [index] };
      },
      getTupleValueFields() {
        return tupleField;
      },
      getQueryAxisItems() {
        return [{ columnName: 'row_field', columnType: 'VARCHAR' }];
      }
    };
    const columnsTupleSet = {
      getTupleCountSync() {
        return 1;
      },
      getTupleSync(index) {
        return { values: [index] };
      },
      getTupleValueFields() {
        return tupleField;
      },
      getQueryAxisItems() {
        return [{ columnName: 'col_field', columnType: 'VARCHAR' }];
      }
    };

    const cellSet = new CellSet(
      queryModel,
      [rowsTupleSet, columnsTupleSet],
      createSettings({ cellSetMaxCacheEntries: 10, cellSetMaxCacheSizeMb: 50 })
    );

    const cells = await cellSet.getCells([[0, 1], [0, 1]]);
    expect(cells[0]).toBeDefined();
    expect(cellSet.cacheSize).toBeGreaterThan(2);
  });
});
