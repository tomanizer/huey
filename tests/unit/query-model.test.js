const { loadScripts } = require('./setup');

describe('QueryModel', () => {
  let window;
  let QueryModel;
  let FilterDialog;

  beforeAll(() => {
    window = loadScripts();
    ({ QueryModel, FilterDialog } = window);
  });

  function createModel() {
    return new QueryModel();
  }

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
});
