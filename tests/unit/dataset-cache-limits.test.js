vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

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

    const singleTupleSet = new TupleSet(queryModel, 'rows', createSettings({
      tupleSetMaxCacheEntries: 10,
      tupleSetMaxCacheSizeMb: 50
    }));
    singleTupleSet.setPageSize(1);
    await singleTupleSet.getTuples(1, 0);

    const twoTupleSet = new TupleSet(queryModel, 'rows', createSettings({
      tupleSetMaxCacheEntries: 10,
      tupleSetMaxCacheSizeMb: 50
    }));
    twoTupleSet.setPageSize(2);
    await twoTupleSet.getTuples(2, 0);

    const maxCacheSizeBytes = Math.floor((singleTupleSet.cacheSize + twoTupleSet.cacheSize) / 2);
    const maxCacheSizeMb = maxCacheSizeBytes / (1024 * 1024);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings({
      tupleSetMaxCacheEntries: 10,
      tupleSetMaxCacheSizeMb: maxCacheSizeMb
    }));
    tupleSet.setPageSize(3);

    await tupleSet.getTuples(3, 0);

    expect(tupleSet.getTupleSync(0)).toBeUndefined();
    expect(tupleSet.getTupleSync(1)).toBeUndefined();
    expect(tupleSet.getTupleSync(2)).toBeDefined();
    expect(tupleSet.cacheSize).toBeLessThanOrEqual(maxCacheSizeBytes);
  });

  test('CellSet evicts least-recently-used cells when entry limit is exceeded', async () => {
    let fetchCellsCallCount = 0;
    const connection = {
      fetchCells(dateRange, query) {
        fetchCellsCallCount += 1;
        const rowCount = query.window?.rows?.limit || 1;
        const colCount = query.window?.columns?.limit || 1;
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

  test('CellSet evicts cells when cache size limit is exceeded', async () => {
    let fetchCellsCallCount = 0;
    const connection = {
      fetchCells(dateRange, query) {
        fetchCellsCallCount += 1;
        const rowCount = query.window?.rows?.limit || 1;
        const colCount = query.window?.columns?.limit || 1;
        const cells = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          for (let columnIndex = 0; columnIndex < colCount; columnIndex++) {
            cells.push({
              row_index: rowIndex,
              column_index: columnIndex,
              values: { 2: `value-${rowIndex}-${columnIndex}-${'x'.repeat(64)}` }
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
        return { getItems: () => [{ columnName: 'amount', columnType: 'VARCHAR', aggregator: 'max' }] };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };
    const tupleField = [{ name: 'value', type: { typeId: 5 } }];
    const rowsTupleSet = {
      getTupleCountSync() {
        return 2;
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

    const sizingCellSet = new CellSet(
      queryModel,
      [rowsTupleSet, columnsTupleSet],
      createSettings({ cellSetMaxCacheEntries: 10, cellSetMaxCacheSizeMb: 50 })
    );
    await sizingCellSet.getCells([[0, 1], [0, 1]]);
    const singleCellCacheSize = sizingCellSet.cacheSize;
    const smallerThanSingleCellCacheSizeMb = (singleCellCacheSize - 1) / (1024 * 1024);

    fetchCellsCallCount = 0;
    const cellSet = new CellSet(
      queryModel,
      [rowsTupleSet, columnsTupleSet],
      createSettings({
        cellSetMaxCacheEntries: 10,
        cellSetMaxCacheSizeMb: smallerThanSingleCellCacheSizeMb
      })
    );

    await cellSet.getCells([[0, 2], [0, 1]]);
    expect(fetchCellsCallCount).toBe(1);

    await cellSet.getCells([[0, 2], [0, 1]]);
    expect(fetchCellsCallCount).toBe(2);
  });

  test('CellSet evicts least-recently-used cells when size limit is exceeded', async () => {
    let fetchCellsCallCount = 0;
    const cellValuePadding = 'x'.repeat(64);
    const connection = {
      fetchCells(dateRange, query) {
        fetchCellsCallCount += 1;
        const rowCount = query.window?.rows?.limit || 1;
        const colCount = query.window?.columns?.limit || 1;
        const cells = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          for (let columnIndex = 0; columnIndex < colCount; columnIndex++) {
            cells.push({
              row_index: rowIndex,
              column_index: columnIndex,
              values: { 2: `value-${rowIndex}-${columnIndex}-${cellValuePadding}` }
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
        return { getItems: () => [{ columnName: 'amount', columnType: 'VARCHAR', aggregator: 'max' }] };
      },
      getFiltersAxis() {
        return { getItems: () => [] };
      }
    };
    const tupleField = [{ name: 'value', type: { typeId: 5 } }];
    const createRowsTupleSet = function(rowCount) {
      return {
        getTupleCountSync() {
          return rowCount;
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

    const oneCellSizingSet = new CellSet(
      queryModel,
      [createRowsTupleSet(1), columnsTupleSet],
      createSettings({ cellSetMaxCacheEntries: 10, cellSetMaxCacheSizeMb: 50 })
    );
    await oneCellSizingSet.getCells([[0, 1], [0, 1]]);
    const oneCellCacheSize = oneCellSizingSet.cacheSize;

    const twoCellSizingSet = new CellSet(
      queryModel,
      [createRowsTupleSet(2), columnsTupleSet],
      createSettings({ cellSetMaxCacheEntries: 10, cellSetMaxCacheSizeMb: 50 })
    );
    await twoCellSizingSet.getCells([[0, 2], [0, 1]]);
    const twoCellCacheSize = twoCellSizingSet.cacheSize;

    const maxCacheSizeBytes = Math.floor((oneCellCacheSize + twoCellCacheSize) / 2);
    const maxCacheSizeMb = maxCacheSizeBytes / (1024 * 1024);

    fetchCellsCallCount = 0;
    const cellSet = new CellSet(
      queryModel,
      [createRowsTupleSet(2), columnsTupleSet],
      createSettings({
        cellSetMaxCacheEntries: 10,
        cellSetMaxCacheSizeMb: maxCacheSizeMb
      })
    );

    const initialCells = await cellSet.getCells([[0, 2], [0, 1]]);
    expect(fetchCellsCallCount).toBe(1);
    expect(cellSet.cacheSize).toBeLessThanOrEqual(maxCacheSizeBytes);

    const cachedSecondCell = await cellSet.getCells([[1, 2], [0, 1]]);
    expect(fetchCellsCallCount).toBe(1);
    expect(cachedSecondCell[1]).toBe(initialCells[1]);

    const refetchedFirstCell = await cellSet.getCells([[0, 1], [0, 1]]);
    expect(fetchCellsCallCount).toBe(2);
    expect(refetchedFirstCell[0]).toBeDefined();
    expect(refetchedFirstCell[0]).not.toBe(initialCells[0]);
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
