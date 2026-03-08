vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
  datasourcesUi: { getDatasource: vi.fn() },
}));

import { serializeQueryModel } from '../../src/QueryModel/QuerySerializer.js';
import { QueryModel } from '../../src/QueryModel/QueryModel.js';
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';

function makeDatasource(id = 'ds1') {
  return {
    getId: () => id,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('serializeQueryModel', () => {
  test('returns null when no datasource is set', async () => {
    const model = new QueryModel();
    expect(serializeQueryModel(model)).toBeNull();
  });

  test('returns null when datasource is set but no items', () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource('ds1'));
    expect(serializeQueryModel(model)).toBeNull();
  });

  test('serializes datasourceId and cellsHeaders', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource('ds-abc'));
    await model.addItem({ columnName: 'country', columnType: 'VARCHAR', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state).not.toBeNull();
    expect(state.datasourceId).toBe('ds-abc');
    expect(state.cellsHeaders).toBe(QueryModel.AXIS_COLUMNS);
  });

  test('serializes rows axis items', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'city', columnType: 'VARCHAR', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state.axes.rows).toHaveLength(1);
    expect(state.axes.rows[0].columnName).toBe('city');
    expect(state.axes.rows[0].columnType).toBe('VARCHAR');
  });

  test('includes derivation when set', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'order_date', columnType: 'DATE', derivation: 'year', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state.axes.rows[0].derivation).toBe('year');
  });

  test('includes aggregator when set', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'amount', columnType: 'DOUBLE', aggregator: 'sum', axis: QueryModel.AXIS_CELLS });

    const state = serializeQueryModel(model);
    expect(state.axes.cells[0].aggregator).toBe('sum');
  });

  test('includes includeTotals only when true', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'region', columnType: 'VARCHAR', axis: QueryModel.AXIS_ROWS, includeTotals: true });
    await model.addItem({ columnName: 'country', columnType: 'VARCHAR', axis: QueryModel.AXIS_COLUMNS });

    const state = serializeQueryModel(model);
    const rowItem = state.axes.rows[0];
    const colItem = state.axes.columns[0];
    expect(rowItem.includeTotals).toBe(true);
    expect(colItem.includeTotals).toBeUndefined();
  });

  test('includes filter only on filters axis', async () => {
    const filter = {
      filterType: FilterDialog.filterTypes.INCLUDE,
      values: { EU: { literal: "'EU'", label: 'EU', enabled: true } },
    };
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'continent', columnType: 'VARCHAR', axis: QueryModel.AXIS_FILTERS, filter });
    await model.addItem({ columnName: 'country', columnType: 'VARCHAR', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state.axes.filters[0].filter).toEqual(filter);
    expect(state.axes.rows[0].filter).toBeUndefined();
  });

  test('includeItemIndices option adds index to items', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'x', columnType: 'INTEGER', axis: QueryModel.AXIS_ROWS });
    await model.addItem({ columnName: 'y', columnType: 'INTEGER', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model, { includeItemIndices: true });
    expect(state.axes.rows[0].index).toBeDefined();
    expect(state.axes.rows[1].index).toBeDefined();
  });

  test('without includeItemIndices option index is omitted', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    await model.addItem({ columnName: 'x', columnType: 'INTEGER', axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state.axes.rows[0].index).toBeUndefined();
  });

  test('memberExpressionPath appears in serialized state when present on item', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource());
    // Use a STRUCT type so getMemberExpressionType resolves the field correctly
    await model.addItem({ columnName: 'meta', columnType: 'STRUCT(name VARCHAR)', memberExpressionPath: ['name'], axis: QueryModel.AXIS_ROWS });

    const state = serializeQueryModel(model);
    expect(state.axes.rows[0].memberExpressionPath).toEqual(['name']);
  });

  test('round-trips through QueryModel.getState', async () => {
    const model = new QueryModel();
    model.setDatasource(makeDatasource('rt-ds'));
    await model.addItem({ columnName: 'country', columnType: 'VARCHAR', axis: QueryModel.AXIS_ROWS });

    const fromSerializer = serializeQueryModel(model);
    const fromGetState = model.getState();
    expect(fromSerializer).toEqual(fromGetState);
  });
});
