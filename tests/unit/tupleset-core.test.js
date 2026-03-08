vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

import { TupleSet } from '../../src/DataSet/TupleSet.js';

function createSettings(overrides) {
  const querySettings = Object.assign({
    tupleSetMaxCacheEntries: 10000,
    tupleSetMaxCacheSizeMb: 50,
  }, overrides || {});
  return {
    getSettings(path) {
      if (Array.isArray(path) && path[0] === 'querySettings') {
        return querySettings[path[1]];
      }
      if (Array.isArray(path) && path[0] === 'localeSettings') {
        return undefined;
      }
      if (Array.isArray(path) && path[0] === 'pivotSettings') {
        return undefined;
      }
      return undefined;
    },
  };
}

function makeRemoteDatasource(allValues) {
  const connection = {
    fetchTuples(_dateRange, query) {
      const paging = query.paging || {};
      const limit = paging.limit || allValues.length;
      const offset = paging.offset || 0;
      const items = allValues.slice(offset, offset + limit).map((value) => ({ values: [value] }));
      return { items, total_count: allValues.length };
    },
    getState() { return 'open'; },
  };
  return {
    getType() { return 'remote'; },
    getManagedConnection() { return connection; },
  };
}

function makeQueryModel(datasource, axisItems) {
  return {
    getDatasource() { return datasource; },
    getQueryAxis() { return { getItems: () => axisItems }; },
    getFiltersAxis() { return { getItems: () => [] }; },
  };
}

describe('TupleSet.getSqlSelectExpressions', () => {
  test('returns undefined when axis has no items', () => {
    const queryModel = {
      getQueryAxis() { return { getItems: () => [] }; },
    };
    expect(TupleSet.getSqlSelectExpressions(queryModel, 'rows')).toBeUndefined();
  });

  test('returns expressions keyed by caption', () => {
    const items = [
      { columnName: 'city' },
      { columnName: 'country' },
    ];
    const queryModel = {
      getQueryAxis() { return { getItems: () => items }; },
    };
    const result = TupleSet.getSqlSelectExpressions(queryModel, 'rows');
    expect(result).toHaveProperty('city');
    expect(result).toHaveProperty('country');
  });

  test('includes COUNT(*) OVER () when includeCountAll is true', () => {
    const items = [{ columnName: 'city' }];
    const queryModel = {
      getQueryAxis() { return { getItems: () => items }; },
    };
    const result = TupleSet.getSqlSelectExpressions(queryModel, 'rows', true);
    expect(result).toHaveProperty('COUNT(*) OVER ()');
  });
});

describe('TupleSet core operations', () => {
  test('getTupleCountSync returns undefined before loading', () => {
    const datasource = makeRemoteDatasource(['A', 'B']);
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    expect(tupleSet.getTupleCountSync()).toBeUndefined();
  });

  test('getTuplesSync returns loaded tuples', async () => {
    const datasource = makeRemoteDatasource(['A', 'B', 'C', 'D']);
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    tupleSet.setPageSize(10);

    await tupleSet.getTuples(4, 0);
    expect(tupleSet.getTupleCountSync()).toBe(4);

    const tuples = tupleSet.getTuplesSync(0, 4);
    expect(tuples.length).toBe(4);
    expect(tuples[0].values).toEqual(['A']);
    expect(tuples[3].values).toEqual(['D']);
  });

  test('getTupleSync returns single tuple by index', async () => {
    const datasource = makeRemoteDatasource(['X', 'Y', 'Z']);
    const axisItems = [{ columnName: 'letter', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    tupleSet.setPageSize(10);

    await tupleSet.getTuples(3, 0);
    expect(tupleSet.getTupleSync(1).values).toEqual(['Y']);
    expect(tupleSet.getTupleSync(5)).toBeUndefined();
  });

  test('clear resets tuples and count', async () => {
    const datasource = makeRemoteDatasource(['A', 'B']);
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    tupleSet.setPageSize(10);

    await tupleSet.getTuples(2, 0);
    expect(tupleSet.getTupleCountSync()).toBe(2);

    tupleSet.clear();
    expect(tupleSet.getTupleCountSync()).toBeUndefined();
    expect(tupleSet.getTupleSync(0)).toBeUndefined();
  });

  test('getCachedTupleCount returns count of contiguous cached tuples', async () => {
    const datasource = makeRemoteDatasource(['A', 'B', 'C', 'D', 'E']);
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    tupleSet.setPageSize(3);

    await tupleSet.getTuples(3, 0);
    expect(tupleSet.getCachedTupleCount(0)).toBe(3);
    // Tuples 3-4 are not loaded
    expect(tupleSet.getCachedTupleCount(3)).toBe(0);
  });

  test('getQueryAxisId returns the axis ID passed to constructor', () => {
    const datasource = makeRemoteDatasource([]);
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'columns', createSettings());
    expect(tupleSet.getQueryAxisId()).toBe('columns');
  });
});

describe('TupleSet pagination', () => {
  test('fetches only missing tuples on second page', async () => {
    let fetchCount = 0;
    const allValues = ['A', 'B', 'C', 'D', 'E', 'F'];
    const connection = {
      fetchTuples(_dateRange, query) {
        fetchCount++;
        const paging = query.paging || {};
        const limit = paging.limit || allValues.length;
        const offset = paging.offset || 0;
        const items = allValues.slice(offset, offset + limit).map((value) => ({ values: [value] }));
        return { items, total_count: allValues.length };
      },
      getState() { return 'open'; },
    };
    const datasource = {
      getType() { return 'remote'; },
      getManagedConnection() { return connection; },
    };
    const axisItems = [{ columnName: 'city', columnType: 'VARCHAR' }];
    const queryModel = makeQueryModel(datasource, axisItems);
    const tupleSet = new TupleSet(queryModel, 'rows', createSettings());
    tupleSet.setPageSize(3);

    // First page
    await tupleSet.getTuples(3, 0);
    expect(fetchCount).toBe(1);
    expect(tupleSet.getTupleCountSync()).toBe(6);

    // Second page - should issue a second fetch
    await tupleSet.getTuples(3, 3);
    expect(fetchCount).toBe(2);

    // All 6 tuples should now be cached
    expect(tupleSet.getTupleSync(0).values).toEqual(['A']);
    expect(tupleSet.getTupleSync(5).values).toEqual(['F']);
  });
});
