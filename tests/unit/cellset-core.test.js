vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings() {
      return {};
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

import { CellSet, getTupleValueLiteral } from '../../src/DataSet/CellSet.js';

function createSettings(overrides) {
  const querySettings = Object.assign({
    cellSetMaxCacheEntries: 10000,
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

function makeTupleSet(tupleCount, queryAxisItems) {
  const tuples = [];
  for (let i = 0; i < tupleCount; i++) {
    tuples.push({ values: [i] });
  }
  return {
    getTupleCountSync() { return tupleCount; },
    getTupleSync(index) { return tuples[index]; },
    getTupleValueFields() { return [{ name: 'v', type: { typeId: 5 } }]; },
    getQueryAxisItems() { return queryAxisItems || [{ columnName: 'dim', columnType: 'VARCHAR' }]; },
  };
}

describe('CellSet.getCellIndex', () => {
  test('returns 0 for single tuple set with index 0', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(5);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    expect(cellSet.getCellIndex(0)).toBe(0);
  });

  test('returns correct index for single tuple set', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(5);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    expect(cellSet.getCellIndex(3)).toBe(3);
  });

  test('computes row-major index for two tuple sets', () => {
    const queryModel = { getDatasource() { return null; } };
    const rowTs = makeTupleSet(3);
    const colTs = makeTupleSet(4);
    const cellSet = new CellSet(queryModel, [rowTs, colTs], createSettings());
    // row=2, col=3 => 2*4 + 3 = 11
    expect(cellSet.getCellIndex(2, 3)).toBe(11);
    // row=0, col=0 => 0
    expect(cellSet.getCellIndex(0, 0)).toBe(0);
    // row=1, col=2 => 1*4 + 2 = 6
    expect(cellSet.getCellIndex(1, 2)).toBe(6);
  });

  test('computes index for three tuple sets', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts1 = makeTupleSet(2);
    const ts2 = makeTupleSet(3);
    const ts3 = makeTupleSet(4);
    const cellSet = new CellSet(queryModel, [ts1, ts2, ts3], createSettings());
    // indices (1, 2, 3) => 1*3*4 + 2*4 + 3 = 12 + 8 + 3 = 23
    expect(cellSet.getCellIndex(1, 2, 3)).toBe(23);
  });
});

describe('CellSet.getTupleRanges', () => {
  test('returns single combination for single-element ranges', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(5);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    const ranges = cellSet.getTupleRanges([[2, 3]]);
    expect(ranges).toEqual([[2]]);
  });

  test('returns multiple combinations for multi-element range', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(5);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    const ranges = cellSet.getTupleRanges([[0, 3]]);
    expect(ranges).toEqual([[0], [1], [2]]);
  });

  test('returns Cartesian product for two tuple sets', () => {
    const queryModel = { getDatasource() { return null; } };
    const rowTs = makeTupleSet(3);
    const colTs = makeTupleSet(2);
    const cellSet = new CellSet(queryModel, [rowTs, colTs], createSettings());
    const ranges = cellSet.getTupleRanges([[0, 2], [0, 2]]);
    expect(ranges).toEqual([
      [0, 0], [0, 1],
      [1, 0], [1, 1],
    ]);
  });

  test('clamps ranges to actual tuple count', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(2);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    const ranges = cellSet.getTupleRanges([[0, 5]]);
    // should be clamped to 2
    expect(ranges).toEqual([[0], [1]]);
  });

  test('handles zero-zero range as single tuple', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(3);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    const ranges = cellSet.getTupleRanges([[0, 0]]);
    expect(ranges).toEqual([[0]]);
  });
});

describe('CellSet clear and cache', () => {
  test('clearCache resets internal state', () => {
    const queryModel = { getDatasource() { return null; } };
    const ts = makeTupleSet(3);
    const cellSet = new CellSet(queryModel, [ts], createSettings());
    cellSet.clearCache();
    expect(cellSet.getCellValueFields()).toEqual({});
    expect(cellSet.cacheSize).toBe(2); // empty JSON '{}'
  });

  test('records last and total query time for fetched cells', async () => {
    const rowsAxisItems = [{ columnName: 'row_dim', columnType: 'VARCHAR' }];
    const columnsAxisItems = [{ columnName: 'column_dim', columnType: 'VARCHAR' }];
    const cellsAxisItems = [{ columnName: 'value', columnType: 'DOUBLE', aggregator: 'sum' }];
    const connection = {
      fetchCells() {
        return {
          cells: [{
            row_index: 0,
            column_index: 0,
            values: {
              2: 11
            }
          }]
        };
      },
      getState() { return 'open'; },
    };
    const queryModel = {
      getDatasource() {
        return {
          getType() { return 'remote'; },
          getManagedConnection() { return connection; },
        };
      },
      getRowsAxis() { return { getItems: () => rowsAxisItems }; },
      getColumnsAxis() { return { getItems: () => columnsAxisItems }; },
      getCellsAxis() { return { getItems: () => cellsAxisItems }; },
      getFiltersAxis() { return { getItems: () => [] }; },
    };
    const rowsTupleSet = makeTupleSet(1, rowsAxisItems);
    const columnsTupleSet = makeTupleSet(1, columnsAxisItems);
    const cellSet = new CellSet(queryModel, [rowsTupleSet, columnsTupleSet], createSettings());
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(18)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(35);

    await cellSet.getCells([[0, 1], [0, 1]]);
    expect(cellSet.getLastQueryTimeMs()).toBe(8);
    expect(cellSet.getTotalQueryTimeMs()).toBe(8);

    cellSet.clearCache();
    await cellSet.getCells([[0, 1], [0, 1]]);
    expect(cellSet.getLastQueryTimeMs()).toBe(5);
    expect(cellSet.getTotalQueryTimeMs()).toBe(5);
  });
});
