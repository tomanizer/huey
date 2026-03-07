import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function createPivotTableUiStub(overrides = {}) {
  const root = document.createElement('div');
  const inner = document.createElement('div');
  const table = document.createElement('div');
  const header = document.createElement('div');
  const body = document.createElement('div');
  table.append(header, body);
  inner.appendChild(table);
  root.appendChild(inner);

  return {
    getDom() {
      return root;
    },
    getInnerContainerDom() {
      return inner;
    },
    getTableHeaderDom() {
      return header;
    },
    getTableBodyDom() {
      return body;
    },
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = `
    <dialog id="errorDialog"></dialog>
    <button id="errorDialogOkButton"></button>
  `;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('pivot table helper components', () => {
  test('resizer only observes real header cells when column observation toggles', async () => {
    const observed = [];
    const unobserved = [];
    class ResizeObserverStub {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        observed.push(target);
      }
      unobserve(target) {
        unobserved.push(target);
      }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    const { PivotTableResizer } = await import('../../src/PivotTableUi/PivotTableResizer.js');
    const pivotTableUi = createPivotTableUiStub();
    const headerRow = document.createElement('div');
    pivotTableUi.getTableHeaderDom().appendChild(headerRow);

    const firstHeaderCell = document.createElement('div');
    firstHeaderCell.className = 'pivotTableUiCell pivotTableUiHeaderCell';
    const stufferCell = document.createElement('div');
    stufferCell.className = 'pivotTableUiCell pivotTableUiHeaderCell pivotTableUiStufferCell';
    const secondHeaderCell = document.createElement('div');
    secondHeaderCell.className = 'pivotTableUiCell pivotTableUiHeaderCell';
    headerRow.append(firstHeaderCell, stufferCell, secondHeaderCell);

    const resizer = new PivotTableResizer(pivotTableUi);
    resizer.toggleObserveColumnsResizing(true);
    resizer.toggleObserveColumnsResizing(false);

    expect(observed).toContain(pivotTableUi.getDom());
    expect(observed).toContain(firstHeaderCell);
    expect(observed).toContain(secondHeaderCell);
    expect(observed).not.toContain(stufferCell);
    expect(unobserved).toEqual([firstHeaderCell, secondHeaderCell]);
  });

  test('context menu captures the closest pivot cell and ignores outside clicks', async () => {
    vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
      QueryModel: {
        AXIS_COLUMNS: 'columns',
        AXIS_ROWS: 'rows',
        AXIS_CELLS: 'cells',
        AXIS_FILTERS: 'filters',
      },
      QueryAxisItem: {
        getIdForQueryAxisItem(item) {
          return item.id;
        },
      },
    }));
    vi.doMock('../../src/FilterUi/FilterUi.js', () => ({
      FilterDialog: {
        equalityFilterTypes: { INCLUDE: 'include', EXCLUDE: 'exclude' },
        filterTypes: { INCLUDE: 'include' },
        simplePatternFilterTypes: {},
        rangeFilterTypes: {},
        arrayFilterTypes: {},
      },
    }));
    vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({ showErrorDialog: vi.fn() }));
    vi.doMock('../../src/util/clipboard/clipboard.js', () => ({ copyToClipboard: vi.fn() }));
    vi.doMock('../../src/ExportUi/ExportDialog.js', () => ({ ExportUi: { exportDataForQueryModel: vi.fn() } }));
    vi.doMock('../../src/DataSource/duckdb/DuckDbDataSource.js', () => ({
      DuckDbDataSource: {
        parseId: vi.fn(() => ({ type: 'table' })),
        types: { FILES: 'files' },
      },
    }));

    const { PivotTableContextMenu } = await import('../../src/PivotTableUi/PivotTableContextMenu.js');
    const pivotTableUi = createPivotTableUiStub();
    const contextMenu = new PivotTableContextMenu(pivotTableUi);

    const outside = document.createElement('button');
    pivotTableUi.getDom().appendChild(outside);
    expect(contextMenu.beforeShowContextMenu({ target: outside })).toBe(false);

    const cell = document.createElement('div');
    cell.className = 'pivotTableUiCell';
    const label = document.createElement('span');
    cell.appendChild(label);
    pivotTableUi.getDom().appendChild(cell);

    expect(contextMenu.beforeShowContextMenu({ target: label })).toBeUndefined();
  });
});
