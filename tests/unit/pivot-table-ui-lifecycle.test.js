import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tupleSetInstances = [];
const cellSetInstances = [];
const VARCHAR_TYPE_ID = 5;
const DOUBLE_TYPE_ID = -12;

vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(path) {
      if (path === 'pivotSettings') {
        return {
          totalsString: 'Totals',
          hideRepeatingAxisValues: true,
          defaultDittoMark: '〃',
          maximumCellWidth: 30,
        };
      }
      if (path === 'querySettings') {
        return {
          autoRunQuery: false,
          autoRunQueryTimeout: 1,
        };
      }
      return {};
    },
  },
}));

vi.mock('../../src/util/event/EventBuffer.js', () => ({
  bufferEvents: vi.fn(),
}));

vi.mock('../../src/ContextMenu/ContextMenu.js', () => ({
  ContextMenu: class ContextMenu {},
}));

vi.mock('../../src/DataSet/TupleSet.js', () => {
  class TupleSet {
    static groupingIdAlias = '__grouping_id';

    constructor(_queryModel, axisId) {
      this.axisId = axisId;
      this.pageSize = 0;
      this.cancelPendingQuery = vi.fn().mockResolvedValue(undefined);
      this.clearCache = vi.fn();
      this.setPageSize = vi.fn((value) => {
        this.pageSize = value;
      });
      this.getPageSize = vi.fn(() => this.pageSize);
      this.getTupleCountSync = vi.fn(() => (axisId === 'rows' ? 1 : 0));
      this.getTupleValueFields = vi.fn(() => [{ name: 'country', type: { typeId: VARCHAR_TYPE_ID, toString: () => 'VARCHAR' } }]);
      this.getQueryAxisItems = vi.fn(() => {
        if (axisId === 'rows') {
          return [{ axis: 'rows', columnName: 'country', columnType: 'VARCHAR' }];
        }
        return [];
      });
      this.getTupleSync = vi.fn(() => ({ values: ['Netherlands'] }));
      this.getTuples = vi.fn(async () => {
        if (axisId === 'rows') {
          return [{ values: ['Netherlands'] }];
        }
        return [];
      });
      tupleSetInstances.push(this);
    }
  }

  return { TupleSet };
});

vi.mock('../../src/DataSet/CellSet.js', () => {
  class CellSet {
    static datasetRelationName = '__data';

    constructor() {
      this.cancelPendingQuery = vi.fn().mockResolvedValue(undefined);
      this.clearCache = vi.fn();
      this.getCellIndex = vi.fn(() => 0);
      this.getCellValueFields = vi.fn(() => ({ sales_sum: { type: { typeId: DOUBLE_TYPE_ID, toString: () => 'DOUBLE' } } }));
      this.getCells = vi.fn(async () => ({
        0: {
          values: {
            sales_sum: 42,
          },
        },
      }));
      cellSetInstances.push(this);
    }
  }

  return { CellSet };
});

vi.mock('../../src/QueryModel/QueryModel.js', () => ({
  QueryModel: {
    AXIS_FILTERS: 'filters',
    AXIS_ROWS: 'rows',
    AXIS_COLUMNS: 'columns',
    AXIS_CELLS: 'cells',
  },
  QueryAxisItem: {
    getCaptionForQueryAxisItem(item) {
      return item.caption || item.columnName || 'item';
    },
    getIdForQueryAxisItem(item) {
      return `${item.axis}-${item.columnName}-${item.aggregator || 'value'}`;
    },
    getSqlForQueryAxisItem(item) {
      return item.aggregator ? `${item.columnName}_${item.aggregator}` : item.columnName;
    },
  },
  queryModel: {},
}));

vi.mock('../../src/AttributeUi/AttributeUi.js', () => ({
  AttributeUi: {
    getDerivationInfo() {
      return {};
    },
  },
}));

vi.mock('../../src/FilterUi/FilterUi.js', () => ({
  FilterDialog: class FilterDialog {},
}));

vi.mock('../../src/PivotTableUi/PivotTableUiHighlighting.js', () => ({
  PivotTableUiHighlighting: class PivotTableUiHighlighting {},
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
}));

vi.mock('../../src/util/clipboard/clipboard.js', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('../../src/util/sql/SQLHelper.js', () => ({
  getDuckDbLiteralForValue(value) {
    return value === null ? 'NULL' : String(value);
  },
  quoteStringLiteral(value) {
    return `'${value}'`;
  },
}));

describe('PivotTableUi lifecycle flows', () => {
  beforeEach(() => {
    tupleSetInstances.length = 0;
    cellSetInstances.length = 0;
    vi.resetModules();
    document.body.innerHTML = '<div id="workarea"></div><button id="cancelQueryButton"></button>';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function createQueryModel() {
    const cellsAxisItems = [
      { axis: 'cells', columnName: 'sales', columnType: 'DOUBLE', aggregator: 'sum', caption: 'Sales' },
    ];
    const rowsAxis = { getItems: () => [{ axis: 'rows', columnName: 'country', columnType: 'VARCHAR' }] };
    const columnsAxis = { getItems: () => [] };
    const cellsAxis = { getItems: () => cellsAxisItems };
    return {
      addEventListener() {},
      getState() {
        return {
          axes: {
            rows: [{ axis: 'rows', columnName: 'country', columnType: 'VARCHAR' }],
            columns: [],
            cells: cellsAxisItems,
          },
        };
      },
      getFilterConditionSql() {
        return '';
      },
      getCellHeadersAxis() {
        return 'columns';
      },
      getRowsAxis() {
        return rowsAxis;
      },
      getColumnsAxis() {
        return columnsAxis;
      },
      getCellsAxis() {
        return cellsAxis;
      },
      getQueryAxis(axisId) {
        switch (axisId) {
          case 'rows':
            return rowsAxis;
          case 'columns':
            return columnsAxis;
          case 'cells':
            return cellsAxis;
          default:
            return { getItems: () => [] };
        }
      },
    };
  }

  function setElementDimensions(element, sizes) {
    for (const [property, value] of Object.entries(sizes)) {
      Object.defineProperty(element, property, {
        configurable: true,
        get() {
          return value;
        },
      });
    }
  }

  test('updatePivotTableUi renders a basic table and emits a success update', async () => {
    const { PivotTableUi } = await import('../../src/PivotTableUi/PivotTableUi.js');
    const pivotTableUi = new PivotTableUi({
      id: 'pivotTableUi',
      container: 'workarea',
      queryModel: createQueryModel(),
      settings: {
        getSettings(path) {
          if (path === 'querySettings') {
            return { autoRunQuery: false, autoRunQueryTimeout: 1 };
          }
          if (path === 'pivotSettings') {
            return { totalsString: 'Totals', hideRepeatingAxisValues: true, defaultDittoMark: '〃', maximumCellWidth: 30 };
          }
          return {};
        },
      },
    });

    const innerContainer = pivotTableUi.getDom().querySelector('.pivotTableUiInnerContainer');
    const table = pivotTableUi.getDom().querySelector('.pivotTableUiTable');
    setElementDimensions(innerContainer, { clientWidth: 640, clientHeight: 320, scrollWidth: 640, scrollHeight: 320, scrollLeft: 0, scrollTop: 0 });
    setElementDimensions(table, { clientWidth: 240, clientHeight: 120 });

    const updatedEvents = [];
    pivotTableUi.addEventListener('updated', (event) => {
      updatedEvents.push(event.eventData);
    });

    await pivotTableUi.updatePivotTableUi();

    expect(tupleSetInstances[0].setPageSize).toHaveBeenCalledWith(100);
    expect(tupleSetInstances[1].setPageSize).toHaveBeenCalledWith(100);
    expect(updatedEvents.some((event) => event.status === 'success')).toBe(true);
    expect(pivotTableUi.getDom().getAttribute('aria-busy')).toBe('false');
    expect(pivotTableUi.getDom().getAttribute('data-needs-update')).toBe('false');
    expect(pivotTableUi.getDom().querySelector('.pivotTableUiTableHeader').childNodes.length).toBeGreaterThan(0);
    expect(pivotTableUi.getDom().querySelector('.pivotTableUiTableBody').childNodes.length).toBeGreaterThan(0);
  });

  test('cancel query button cancels pending tuple and cell requests and marks the table dirty', async () => {
    const { PivotTableUi } = await import('../../src/PivotTableUi/PivotTableUi.js');
    const pivotTableUi = new PivotTableUi({
      id: 'pivotTableUi',
      container: 'workarea',
      queryModel: createQueryModel(),
      settings: {
        getSettings() {
          return {};
        },
      },
    });

    document.getElementById('cancelQueryButton').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(tupleSetInstances[0].cancelPendingQuery).toHaveBeenCalledTimes(1);
    expect(tupleSetInstances[1].cancelPendingQuery).toHaveBeenCalledTimes(1);
    expect(cellSetInstances[0].cancelPendingQuery).toHaveBeenCalledTimes(1);
    expect(pivotTableUi.getDom().getAttribute('data-needs-update')).toBe('true');
  });

  test('clear removes rendered table contents and emits an updated event', async () => {
    const { PivotTableUi } = await import('../../src/PivotTableUi/PivotTableUi.js');
    const pivotTableUi = new PivotTableUi({
      id: 'pivotTableUi',
      container: 'workarea',
      queryModel: createQueryModel(),
      settings: {
        getSettings() {
          return {};
        },
      },
    });

    const updated = vi.fn();
    pivotTableUi.addEventListener('updated', updated);
    const header = pivotTableUi.getDom().querySelector('.pivotTableUiTableHeader');
    const body = pivotTableUi.getDom().querySelector('.pivotTableUiTableBody');
    header.appendChild(document.createElement('div'));
    body.appendChild(document.createElement('div'));

    pivotTableUi.clear();

    expect(header.childNodes.length).toBe(0);
    expect(body.childNodes.length).toBe(0);
    expect(updated).toHaveBeenCalled();
  });
});
