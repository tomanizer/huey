import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/FilterUi/FilterUi.js', () => ({
  FilterDialog: {
    filterTypes: {
      INCLUDE: 'include',
    },
    getLabelForFilterType(filterType) {
      return filterType;
    },
  },
  filterDialog: {},
}));

vi.mock('../../src/Internationalization/Internationalization.js', () => ({
  Internationalization: {
    getText(value) {
      return value;
    },
    setAttributes(element, attributeName, value) {
      element.setAttribute(attributeName, value);
    },
    setTextContent(element, value) {
      element.textContent = value;
    },
  },
}));

describe('QueryUi core interaction flows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = '<div id="workarea"></div>';
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 120;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function setupQueryUi(seedModel) {
    const queryModelModule = await import('../../src/QueryModel/QueryModel.js');
    const { QueryUi } = await import('../../src/QueryUi/QueryUi.js');

    queryModelModule.initQueryModel();
    const model = queryModelModule.queryModel;
    if (seedModel) {
      await seedModel(model, queryModelModule.QueryModel);
    }

    let activeQueryAxisItem;
    const filterDialogDom = document.createElement('dialog');
    document.body.appendChild(filterDialogDom);
    const filterDialog = {
      openFilterDialog: vi.fn((_queryModel, queryAxisItem) => {
        activeQueryAxisItem = queryAxisItem;
      }),
      getDom: () => filterDialogDom,
      getQueryAxisItem: () => activeQueryAxisItem,
    };

    const queryUi = new QueryUi({
      id: 'queryUi',
      container: 'workarea',
      queryModel: model,
      filterDialog,
    });

    return {
      model,
      QueryModel: queryModelModule.QueryModel,
      queryUi,
      filterDialog,
    };
  }

  test('axis action buttons flip axes, clear items, and move cell headers', async () => {
    const { model, QueryModel } = await setupQueryUi(async (queryModel, QueryModelCtor) => {
      await queryModel.addItem({ columnName: 'country', columnType: 'VARCHAR', axis: QueryModelCtor.AXIS_ROWS });
      await queryModel.addItem({ columnName: 'city', columnType: 'VARCHAR', axis: QueryModelCtor.AXIS_COLUMNS });
      await queryModel.addItem({ columnName: 'sales', columnType: 'DOUBLE', aggregator: 'sum', axis: QueryModelCtor.AXIS_CELLS });
    });

    document.querySelector('#queryUi-rows button[id$="-axis-primary-action"]').click();
    await vi.runAllTimersAsync();

    expect(model.getRowsAxis().getItems().map((item) => item.columnName)).toEqual(['city']);
    expect(model.getColumnsAxis().getItems().map((item) => item.columnName)).toEqual(['country']);
    expect(document.querySelector('#queryUi-rows li span').textContent).toBe('city');
    expect(document.querySelector('#queryUi-columns li span').textContent).toBe('country');

    document.querySelector('#queryUi-cells button[id$="-axis-primary-action"]').click();
    expect(model.getCellHeadersAxis()).toBe(QueryModel.AXIS_ROWS);

    document.querySelector('#queryUi-rows button[id$="-clear-axis"]').click();
    await vi.runAllTimersAsync();

    expect(model.getRowsAxis().getItems()).toHaveLength(0);
  });

  test('filter item actions open the dialog and toggle selected values', async () => {
    const { model, QueryModel, filterDialog } = await setupQueryUi();

    await model.addItem({
      columnName: 'continent',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_FILTERS,
      filter: {
        filterType: 'include',
        toggleState: 'open',
        values: {
          EU: { label: 'EU', literal: "'EU'", enabled: true },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(150);

    document.querySelector('#queryUi-filters button[id$="-edit-filter-condition"]').click();
    expect(filterDialog.openFilterDialog).toHaveBeenCalledTimes(1);

    document.querySelector('#queryUi-filters li[data-value="EU"] input[type="checkbox"]').click();
    await vi.runAllTimersAsync();

    expect(model.getFiltersAxis().getItems()[0].filter.values.EU.enabled).toBe(false);
  });

  test('adding an empty filter schedules a filter dialog reopen for follow-up editing', async () => {
    const { model, QueryModel, filterDialog } = await setupQueryUi();

    await model.addItem({
      columnName: 'region',
      columnType: 'VARCHAR',
      axis: QueryModel.AXIS_FILTERS,
      filter: {
        filterType: 'include',
        values: {},
      },
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(filterDialog.openFilterDialog).toHaveBeenCalledTimes(1);
    expect(filterDialog.openFilterDialog.mock.calls[0][1].columnName).toBe('region');
  });
});
