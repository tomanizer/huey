import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = '';
});

function installAppDom() {
  document.body.innerHTML = `
    <main id="layout">
      <menu role="toolbar">
        <label id="currentDatasource" data-current-datasource="">Current datasource</label>
        <button id="runQueryButton"></button>
        <input id="autoRunQuery" type="checkbox"/>
        <output id="queryResultRowsInfo"></output>
        <output id="queryResultColumnsInfo"></output>
        <span id="queryPerformanceInfo" hidden>
          <span id="queryTimeInfo"></span>
          <span id="renderTimeInfo"></span>
        </span>
      </menu>
      <div class="workarea">
        <div id="pivotTableUi" data-needs-update="false"></div>
      </div>
    </main>
    <dialog id="visualizationProgressDialog"></dialog>
  `;
  const busyDialog = document.getElementById('visualizationProgressDialog');
  busyDialog.showModal = vi.fn();
  busyDialog.close = vi.fn();
}

describe('App performance metrics wiring', () => {
  test('updated events render metrics, log them locally, and forward them over postMessage', async () => {
    installAppDom();

    const pivotTableListeners = {};
    const pivotTableUi = {
      addEventListener: vi.fn((eventName, listener) => {
        pivotTableListeners[eventName] = listener;
      }),
      updatePivotTableUi: vi.fn(),
    };
    const postMessageInterface = {
      sendReadyMessage: vi.fn(),
      sendMessage: vi.fn(),
    };

    vi.doMock('../../src/util/event/EventBuffer.js', () => ({
      bufferEvents: vi.fn(),
    }));
    vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
      settings: {
        getSettings(path) {
          if (Array.isArray(path) && path[0] === 'querySettings' && path[1] === 'autoRunQuery') {
            return false;
          }
          return undefined;
        },
        assignSettings: vi.fn(),
        addEventListener() {},
        removeEventListener() {},
      },
    }));
    vi.doMock('../../src/util/sql/SQLHelper.js', () => ({
      getQuotedIdentifier: vi.fn((identifier) => `"${identifier}"`),
      createNumberFormatter: vi.fn(() => ({ format: (value) => String(value) })),
    }));
    vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
      showErrorDialog: vi.fn(),
    }));
    vi.doMock('../../src/DragAndDrop/DragableDialogs.js', () => ({
      initDragableDialogs: vi.fn(),
    }));
    vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
      QueryModel: {
        AXIS_COLUMNS: 'columns',
        AXIS_ROWS: 'rows',
        AXIS_CELLS: 'cells',
      },
      queryModel: {},
      initQueryModel: vi.fn(),
    }));
    vi.doMock('../../src/AttributeUi/AttributeUi.js', () => ({
      initAttributeUi: vi.fn(),
    }));
    vi.doMock('../../src/Search/Search.js', () => ({
      initSearch: vi.fn(),
    }));
    vi.doMock('../../src/UploadUi/UploadUi.js', () => ({
      initUploadUi: vi.fn(),
    }));
    vi.doMock('../../src/ExportUi/ExportDialog.js', () => ({
      ExportUi: {
        generateExportTitle: vi.fn(() => 'Generated title'),
      },
      initExportDialog: vi.fn(),
    }));
    vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
      DataSourcesUi: {
        getCaptionForDatasource: vi.fn(() => 'Datasource'),
      },
      initDataSourcesUi: vi.fn(),
    }));
    vi.doMock('../../src/DatasourceSettingsDialog/DatasourceSettingsDialog.js', () => ({
      initDatasourceSettingsDialog: vi.fn(),
    }));
    vi.doMock('../../src/FilterUi/FilterUi.js', () => ({
      initFilterUi: vi.fn(),
    }));
    vi.doMock('../../src/QueryUi/QueryUi.js', () => ({
      initQueryUi: vi.fn(),
    }));
    vi.doMock('../../src/PivotTableUi/PivotTableUi.js', () => ({
      pivotTableUi,
      initPivotTableUi: vi.fn(),
    }));
    vi.doMock('../../src/Routing/Routing.js', () => ({
      Routing: {
        getCurrentRoute: vi.fn(() => undefined),
        updateRouteFromQueryModel: vi.fn(),
      },
    }));
    vi.doMock('../../src/PageStateManager/PageStateManager.js', () => ({
      pageStateManager: {
        setPageState: vi.fn(),
      },
      initPageStateManager: vi.fn(),
    }));
    vi.doMock('../../src/SessionCloner/SessionCloner.js', () => ({
      initSessionCloner: vi.fn(),
    }));
    vi.doMock('../../src/QuickQueryMenu/QuickQueryMenu.js', () => ({
      initQuickQueryMenu: vi.fn(),
    }));
    vi.doMock('../../src/DataSourceMenu/DataSourceMenu.js', () => ({
      initDataSourceMenu: vi.fn(),
    }));
    vi.doMock('../../src/PostMessageInterface/PostMessageInterface.js', () => ({
      postMessageInterface,
      initPostMessageInterface: vi.fn(),
    }));
    vi.doMock('../../src/DataSource/duckdb/database.js', () => ({
      getConnection: vi.fn(() => null),
      setReservedWords: vi.fn(),
    }));
    vi.doMock('../../src/Theme/Theme.js', () => ({
      Theme: {},
    }));

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { initApplication } = await import('../../src/App/App.js');

    initApplication();

    expect(postMessageInterface.sendReadyMessage).toHaveBeenCalledTimes(1);
    expect(pivotTableListeners.updated).toBeTypeOf('function');

    pivotTableListeners.updated({
      eventData: {
        status: 'success',
        tupleCounts: {
          rows: 12,
          columns: 4,
          cells: {
            axis: 'rows',
            count: 2,
          },
        },
        metrics: {
          queryTimeMs: 15,
          renderTimeMs: 8,
          totalTimeMs: 23,
          rowCount: 12,
          columnCount: 4,
        },
      },
    });

    expect(document.getElementById('queryResultRowsInfo').textContent).toBe('12 × 2');
    expect(document.getElementById('queryResultColumnsInfo').textContent).toBe('4');
    expect(document.getElementById('queryTimeInfo').textContent).toBe('Query: 15ms');
    expect(document.getElementById('renderTimeInfo').textContent).toBe('Render: 8ms');
    expect(document.getElementById('queryPerformanceInfo').hidden).toBe(false);
    expect(postMessageInterface.sendMessage).toHaveBeenCalledWith({
      messageType: 'performance',
      body: {
        queryTimeMs: 15,
        renderTimeMs: 8,
        totalTimeMs: 23,
        rowCount: 12,
        columnCount: 4,
      },
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('[Performance]', {
      query: '15ms',
      render: '8ms',
      total: '23ms',
      rows: 12,
      columns: 4,
    });
  });
});
