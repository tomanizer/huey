import {
  AXIS_FILTERS,
  AXIS_ROWS,
  AXIS_COLUMNS,
  AXIS_CELLS,
} from '../../src/QueryModel/QueryModelConstants.js';

describe('QueryModelConstants', () => {
  test('AXIS_FILTERS is "filters"', () => {
    expect(AXIS_FILTERS).toBe('filters');
  });

  test('AXIS_ROWS is "rows"', () => {
    expect(AXIS_ROWS).toBe('rows');
  });

  test('AXIS_COLUMNS is "columns"', () => {
    expect(AXIS_COLUMNS).toBe('columns');
  });

  test('AXIS_CELLS is "cells"', () => {
    expect(AXIS_CELLS).toBe('cells');
  });

  test('all four constants are unique strings', () => {
    const values = [AXIS_FILTERS, AXIS_ROWS, AXIS_COLUMNS, AXIS_CELLS];
    const unique = new Set(values);
    expect(unique.size).toBe(4);
  });

  test('constants match QueryModel static fields', async () => {
    // QueryModel re-exports from QueryModelConstants — verify they match
    vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
      settings: {
        getSettings() { return {}; },
        assignSettings() {},
        addEventListener() {},
        removeEventListener() {},
        ready() {},
      },
    }));
    vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
      showErrorDialog: vi.fn(),
      getDataFromError: vi.fn(),
      initErrorDialog: vi.fn(),
    }));
    vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
      datasourcesUi: { getDatasource: vi.fn() },
    }));
    const { QueryModel } = await import('../../src/QueryModel/QueryModel.js');
    expect(QueryModel.AXIS_FILTERS).toBe(AXIS_FILTERS);
    expect(QueryModel.AXIS_ROWS).toBe(AXIS_ROWS);
    expect(QueryModel.AXIS_COLUMNS).toBe(AXIS_COLUMNS);
    expect(QueryModel.AXIS_CELLS).toBe(AXIS_CELLS);
  });
});
