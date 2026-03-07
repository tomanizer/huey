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

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn(),
}));

const { getDatasourceMock } = vi.hoisted(() => ({
  getDatasourceMock: vi.fn(),
}));

vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
  datasourcesUi: {
    getDatasource: getDatasourceMock,
  },
}));

import { QueryModel } from '../../src/QueryModel/QueryModel.js';
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';

describe('QueryModel', () => {
  function createModel() {
    return new QueryModel();
  }

  beforeEach(() => {
    getDatasourceMock.mockReset();
  });

  test('addItem adds to specified axis', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    expect(model.getRowsAxis().getItems()).toHaveLength(1);
  });

  test('removeItem removes from axis', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    const removed = model.removeItem({
      columnName: 'country',
      axis: QueryModel.AXIS_ROWS,
    });
    expect(removed.columnName).toBe('country');
    expect(model.getRowsAxis().getItems()).toHaveLength(0);
  });

  test('findItem locates item across axes', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_COLUMNS,
    });
    const found = model.findItem({ columnName: 'city' });
    expect(found.axis).toBe(QueryModel.AXIS_COLUMNS);
  });

  test('clear removes all items from all axes', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_COLUMNS,
    });
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    model.clear();
    expect(model.getColumnsAxis().getItems()).toHaveLength(0);
    expect(model.getRowsAxis().getItems()).toHaveLength(0);
  });

  test('flipAxes swaps rows and columns', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_COLUMNS,
    });
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    model.flipAxes();

    const rows = model.getRowsAxis().getItems();
    const columns = model.getColumnsAxis().getItems();
    expect(rows[0].columnName).toBe('city');
    expect(columns[0].columnName).toBe('country');
  });

  test('getState serializes model to plain object', async () => {
    const datasource = {
      getId: () => 'ds1',
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const model = createModel();
    model.setDatasource(datasource);
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    await model.addItem({
      columnName: 'continent',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_FILTERS,
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { EU: { literal: "'EU'", label: 'EU', enabled: true } },
      },
    });

    const state = model.getState({ includeItemIndices: true });

    expect(state.datasourceId).toBe('ds1');
    expect(state.axes.rows[0].columnName).toBe('country');
    expect(state.axes.filters[0].filter.filterType).toBe(
      FilterDialog.filterTypes.INCLUDE
    );
  });

  test('setDatasource removes and reuses the same destroy listener', () => {
    const datasource1 = {
      getId: () => 'ds1',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const datasource2 = {
      getId: () => 'ds2',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const model = createModel();

    model.setDatasource(datasource1);
    model.setDatasource(datasource2);

    const addedListener = datasource1.addEventListener.mock.calls[0][1];
    const removedListener = datasource1.removeEventListener.mock.calls[0][1];
    expect(typeof addedListener).toBe('function');
    expect(removedListener).toBe(addedListener);
    expect(datasource2.addEventListener.mock.calls[0][1]).toBe(addedListener);
  });

  test('compareStates detects added items', () => {
    const oldState = { axes: { rows: [] } };
    const newState = {
      axes: {
        rows: [{ columnName: 'city', columnType: 'VARCHAR' }],
      },
    };
    const change = QueryModel.compareStates(oldState, newState);
    expect(change.axesChanged.rows.added).toHaveLength(1);
  });

  test('compareStates detects removed items', () => {
    const oldState = {
      axes: {
        rows: [{ columnName: 'city', columnType: 'VARCHAR' }],
      },
    };
    const newState = { axes: { rows: [] } };
    const change = QueryModel.compareStates(oldState, newState);
    expect(change.axesChanged.rows.removed).toHaveLength(1);
  });

  test('compareStates detects changed properties', () => {
    const item = { columnName: 'city', columnType: 'VARCHAR' };
    const oldState = { axes: { rows: [item] } };
    const newState = {
      axes: { rows: [{ ...item, includeTotals: true }] },
    };
    const change = QueryModel.compareStates(oldState, newState);
    const changedItem = Object.values(change.axesChanged.rows.changed)[0];
    expect(changedItem.includeTotals.newValue).toBe(true);
  });

  test('setState restores state from snapshot', async () => {
    const datasource = {
      getId: () => 'ds-restore',
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    getDatasourceMock.mockReturnValue(datasource);
    const model = createModel();

    await model.setState({
      datasourceId: 'ds-restore',
      cellsHeaders: QueryModel.AXIS_ROWS,
      axes: {
        rows: [{ columnName: 'country', columnType: 'VARCHAR' }],
        filters: [{
          columnName: 'continent',
          columnType: 'VARCHAR',
          filter: {
            filterType: FilterDialog.filterTypes.INCLUDE,
            values: { EU: { literal: "'EU'", label: 'EU', enabled: true } },
          },
        }],
      },
      sampling: {
        rows: { size: 10, unit: 'PERCENT' },
      },
    });

    const state = model.getState({ includeItemIndices: true });
    expect(state.datasourceId).toBe('ds-restore');
    expect(state.cellsHeaders).toBe(QueryModel.AXIS_ROWS);
    expect(state.axes.rows[0].columnName).toBe('country');
    expect(state.axes.filters[0].filter.filterType).toBe(FilterDialog.filterTypes.INCLUDE);
    expect(model.getSampling('rows')).toEqual({ size: 10, unit: 'PERCENT' });
  });

  test('compareStates ignores axis item reordering', () => {
    const a = { columnName: 'country', columnType: 'VARCHAR' };
    const b = { columnName: 'city', columnType: 'VARCHAR' };
    const oldState = { axes: { rows: [a, b] } };
    const newState = { axes: { rows: [b, a] } };

    const change = QueryModel.compareStates(oldState, newState);
    expect(change.axesChanged.rows).toBeUndefined();
    expect(Object.keys(change.axesChanged)).toHaveLength(0);
  });

  test('compareStates detects multiple simultaneous changes', () => {
    const oldState = {
      datasourceId: 'ds-old',
      axes: {
        rows: [{ columnName: 'country', columnType: 'VARCHAR' }],
        columns: [{ columnName: 'city', columnType: 'VARCHAR' }],
      },
    };
    const newState = {
      datasourceId: 'ds-new',
      axes: {
        rows: [
          { columnName: 'country', columnType: 'VARCHAR', includeTotals: true },
          { columnName: 'continent', columnType: 'VARCHAR' },
        ],
        columns: [],
      },
    };

    const change = QueryModel.compareStates(oldState, newState);
    expect(change.propertiesChanged.datasourceId.newValue).toBe('ds-new');
    expect(change.axesChanged.rows.added).toHaveLength(1);
    expect(change.axesChanged.columns.removed).toHaveLength(1);
    const changedRow = Object.values(change.axesChanged.rows.changed)[0];
    expect(changedRow.includeTotals.newValue).toBe(true);
  });

  test('compareStates detects empty to populated transitions', () => {
    const change = QueryModel.compareStates(
      { axes: { filters: [] } },
      {
        axes: {
          filters: [{
            columnName: 'region',
            columnType: 'VARCHAR',
            filter: {
              filterType: FilterDialog.filterTypes.INCLUDE,
              values: { emea: { literal: "'EMEA'", label: 'EMEA', enabled: true } },
            },
          }],
        },
      }
    );
    expect(change.axesChanged.filters.added).toHaveLength(1);
  });

  test('addItem duplicate add is a no-op', async () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    expect(model.getRowsAxis().getItems()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test('addItem with undefined index moves existing same-axis item to end', async () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    await model.addItem({
      columnName: 'first',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    await model.addItem({
      columnName: 'second',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    await model.addItem({
      columnName: 'first',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    const rowItems = model.getRowsAxis().getItems();
    expect(rowItems.map((item) => item.columnName)).toEqual(['second', 'first']);
    expect(events).toHaveLength(3);
  });

  test('moveItem moves item between axes and emits axis change payload', async () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    const item = await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    await model.moveItem(item, QueryModel.AXIS_COLUMNS);

    expect(model.getRowsAxis().getItems()).toHaveLength(0);
    expect(model.getColumnsAxis().getItems()).toHaveLength(1);
    const moveEvent = events[1];
    expect(moveEvent.axesChanged.rows.removed).toHaveLength(1);
    expect(moveEvent.axesChanged.columns.added).toHaveLength(1);
  });

  test('adding filter item emits filter-axis change payload', async () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    await model.addItem({
      columnName: 'segment',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_FILTERS,
      filter: {
        filterType: FilterDialog.filterTypes.EXCLUDE,
        values: { retail: { literal: "'Retail'", label: 'Retail', enabled: true } },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].axesChanged.filters.added[0].filter.filterType).toBe(FilterDialog.filterTypes.EXCLUDE);
  });

  test('setCellHeadersAxis emits change only for actual changes', () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    model.setCellHeadersAxis(model.getCellHeadersAxis());
    model.setCellHeadersAxis(QueryModel.AXIS_ROWS);

    expect(events).toHaveLength(1);
    expect(events[0].propertiesChanged.cellHeadersAxis.newValue).toBe(QueryModel.AXIS_ROWS);
  });

  test('addItem infers axis and metadata, and validates missing axis', async () => {
    const datasource = {
      getId: () => 'ds-meta',
      addEventListener: () => {},
      removeEventListener: () => {},
      getColumnMetadata: async () => ({
        numRows: 1,
        get: () => ({ column_name: 'amount', column_type: 'DOUBLE' }),
      }),
    };
    const model = createModel();
    model.setDatasource(datasource);

    const cellConfig = {
      columnName: 'amount',
      aggregator: 'count',
    };
    expect(cellConfig.axis).toBeUndefined();
    const cellItem = await model.addItem(cellConfig);
    expect(cellItem.axis).toBe(QueryModel.AXIS_CELLS);
    expect(cellItem.columnType).toBe('DOUBLE');
    expect(cellConfig.axis).toBe(QueryModel.AXIS_CELLS);

    await expect(model.addItem({ columnName: 'broken' })).rejects.toThrow("Can't add item: No axis specified!");
  });

  test('toggleTotals, filter mutation APIs and filter SQL work together', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    await model.addItem({
      columnName: 'city',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_FILTERS,
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { ams: { literal: "'Amsterdam'", label: 'Amsterdam', enabled: true } },
      },
    });

    const toggleResult = model.toggleTotals({ columnName: 'city', axis: QueryModel.AXIS_ROWS }, true);
    expect(toggleResult.columnName).toBe('city');

    model.setQueryAxisItemFilter(
      { columnName: 'city', axis: QueryModel.AXIS_FILTERS, filter: { toggleState: 'open' } },
      {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { rtm: { literal: "'Rotterdam'", label: 'Rotterdam', enabled: true } },
      }
    );

    model.setQueryAxisItemFilterToggleState(
      { columnName: 'city', axis: QueryModel.AXIS_FILTERS },
      'open'
    );

    const sqlWithoutTupleFilters = model.getFilterConditionSql(true, 'd');
    const sqlWithTupleFilters = model.getFilterConditionSql(false, 'd');
    expect(sqlWithoutTupleFilters).toBeUndefined();
    expect(sqlWithTupleFilters).toContain('Rotterdam');
  });

  test('clear no-op on empty axis and targeted clear remove items', async () => {
    const model = createModel();
    const events = [];
    model.addEventListener('change', (event) => events.push(event.eventData));

    model.clear(QueryModel.AXIS_ROWS);
    expect(events).toHaveLength(0);

    await model.addItem({
      columnName: 'country',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });
    model.clear(QueryModel.AXIS_ROWS);
    expect(model.getRowsAxis().getItems()).toHaveLength(0);
    expect(events).toHaveLength(2);
  });

  test('setQueryAxisItemFilter validates axis and membership', async () => {
    const model = createModel();
    await model.addItem({
      columnName: 'segment',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_ROWS,
    });

    expect(() => {
      model.setQueryAxisItemFilter(
        { columnName: 'segment', axis: QueryModel.AXIS_ROWS },
        { filterType: FilterDialog.filterTypes.INCLUDE, values: {} }
      );
    }).toThrow('Item is not a filter axis item!');

    expect(() => {
      model.setQueryAxisItemFilterToggleState(
        { columnName: 'segment', axis: QueryModel.AXIS_FILTERS },
        'closed'
      );
    }).toThrow('Item is not part of the model!');
  });
});
