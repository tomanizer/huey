import { afterEach, describe, expect, test, vi } from 'vitest';

function createAppDom() {
  document.body.innerHTML = `
    <div id="workarea"></div>
    <span id="duckdbVersionLabel"></span>
    <img id="duckdb-version-specific-avatar" hidden />
    <button id="runQueryButton"></button>
    <input id="autoRunQuery" type="checkbox" />
    <div id="currentDatasource">current</div>
    <div id="queryResultRowsInfo"></div>
    <div id="queryResultColumnsInfo"></div>
    <div id="queryPerformanceInfo"></div>
    <dialog id="visualizationProgressDialog"><p id="visualizationProgressMessage"></p></dialog>
  `;
  const busyDialog = document.getElementById('visualizationProgressDialog');
  busyDialog.showModal = vi.fn();
  busyDialog.close = vi.fn();
}

async function loadAppModule(options = {}) {
  vi.resetModules();
  const queryHandlers = [];
  const busyHandlers = [];
  const pivotHandlers = {};
  const calls = {};
  const datasource = { id: 'sales-ds' };
  const route = options.route || '#/restored';
  const autoRunQuery = options.autoRunQuery ?? false;
  const connectionQuery = options.connectionQuery || vi.fn().mockResolvedValue({
    get() {
      return {
        version: 'v1.2.3',
        api: 'wasm',
        reserved_words: '[select,from]',
      };
    },
  });

  window.history.replaceState({}, '', options.search || '/');
  createAppDom();

  const queryModelMock = {
    getDatasource: vi.fn(() => datasource),
    getCellsAxis: vi.fn(() => ({ getItems: () => [{ axis: 'cells', columnName: 'sales' }] })),
    getCellHeadersAxis: vi.fn(() => 'rows'),
  };

  const pivotTableUiMock = {
    updatePivotTableUi: vi.fn(),
    addEventListener: vi.fn((eventName, handler) => {
      pivotHandlers[eventName] = handler;
    }),
  };

  vi.doMock('../../src/util/event/EventBuffer.js', () => ({
    bufferEvents: vi.fn((target, eventName, handler) => {
      if (target === queryModelMock && eventName === 'change') {
        queryHandlers.push(handler);
      }
      if (target === pivotTableUiMock && eventName === 'busy') {
        busyHandlers.push(handler);
      }
    }),
  }));

  const settingsMock = {
    getSettings: vi.fn((path) => {
      if (Array.isArray(path) && path[0] === 'querySettings' && path[1] === 'autoRunQuery') {
        return autoRunQuery;
      }
      return undefined;
    }),
    assignSettings: vi.fn(),
    ready: vi.fn(),
  };
  calls.settings = settingsMock;

  vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
    settings: settingsMock,
  }));

  const showErrorDialog = vi.fn();
  calls.showErrorDialog = showErrorDialog;
  vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
    showErrorDialog,
    initErrorDialog: vi.fn(),
  }));

  vi.doMock('../../src/util/sql/SQLHelper.js', () => ({
    getQuotedIdentifier: (value) => `"${value}"`,
    createNumberFormatter: () => ({ format: (value) => `#${value}` }),
  }));

  calls.initDragableDialogs = vi.fn();
  vi.doMock('../../src/DragAndDrop/DragableDialogs.js', () => ({ initDragableDialogs: calls.initDragableDialogs }));

  calls.initQueryModel = vi.fn();
  vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
    QueryModel: {
      AXIS_ROWS: 'rows',
      AXIS_COLUMNS: 'columns',
      AXIS_CELLS: 'cells',
    },
    queryModel: queryModelMock,
    initQueryModel: calls.initQueryModel,
  }));

  calls.initAttributeUi = vi.fn();
  vi.doMock('../../src/AttributeUi/AttributeUi.js', () => ({ initAttributeUi: calls.initAttributeUi }));
  calls.initSearch = vi.fn();
  vi.doMock('../../src/Search/Search.js', () => ({ initSearch: calls.initSearch }));
  calls.initUploadUi = vi.fn();
  vi.doMock('../../src/UploadUi/UploadUi.js', () => ({ initUploadUi: calls.initUploadUi }));

  calls.initExportDialog = vi.fn();
  calls.generateExportTitle = vi.fn(() => 'Sales Overview');
  vi.doMock('../../src/ExportUi/ExportDialog.js', () => ({
    ExportUi: { generateExportTitle: calls.generateExportTitle },
    initExportDialog: calls.initExportDialog,
  }));

  calls.initDataSourcesUi = vi.fn();
  calls.getCaptionForDatasource = vi.fn(() => 'Sales datasource');
  vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
    DataSourcesUi: { getCaptionForDatasource: calls.getCaptionForDatasource },
    initDataSourcesUi: calls.initDataSourcesUi,
  }));

  calls.initDatasourceSettingsDialog = vi.fn();
  vi.doMock('../../src/DatasourceSettingsDialog/DatasourceSettingsDialog.js', () => ({ initDatasourceSettingsDialog: calls.initDatasourceSettingsDialog }));
  calls.initFilterUi = vi.fn();
  vi.doMock('../../src/FilterUi/FilterUi.js', () => ({ initFilterUi: calls.initFilterUi }));
  calls.initQueryUi = vi.fn();
  vi.doMock('../../src/QueryUi/QueryUi.js', () => ({ initQueryUi: calls.initQueryUi }));

  calls.initPivotTableUi = vi.fn();
  vi.doMock('../../src/PivotTableUi/PivotTableUi.js', () => ({
    pivotTableUi: pivotTableUiMock,
    initPivotTableUi: calls.initPivotTableUi,
  }));

  calls.updateRouteFromQueryModel = vi.fn();
  calls.getCurrentRoute = vi.fn(() => route);
  vi.doMock('../../src/Routing/Routing.js', () => ({
    Routing: {
      getCurrentRoute: calls.getCurrentRoute,
      updateRouteFromQueryModel: calls.updateRouteFromQueryModel,
    },
  }));

  calls.setPageState = vi.fn();
  calls.initPageStateManager = vi.fn();
  vi.doMock('../../src/PageStateManager/PageStateManager.js', () => ({
    pageStateManager: { setPageState: calls.setPageState },
    initPageStateManager: calls.initPageStateManager,
  }));

  calls.initSessionCloner = vi.fn();
  vi.doMock('../../src/SessionCloner/SessionCloner.js', () => ({ initSessionCloner: calls.initSessionCloner }));
  calls.initQuickQueryMenu = vi.fn();
  vi.doMock('../../src/QuickQueryMenu/QuickQueryMenu.js', () => ({ initQuickQueryMenu: calls.initQuickQueryMenu }));
  calls.initDataSourceMenu = vi.fn();
  vi.doMock('../../src/DataSourceMenu/DataSourceMenu.js', () => ({ initDataSourceMenu: calls.initDataSourceMenu }));

  calls.initPostMessageInterface = vi.fn();
  calls.sendReadyMessage = vi.fn();
  vi.doMock('../../src/PostMessageInterface/PostMessageInterface.js', () => ({
    postMessageInterface: { sendReadyMessage: calls.sendReadyMessage },
    initPostMessageInterface: calls.initPostMessageInterface,
  }));

  calls.setReservedWords = vi.fn();
  vi.doMock('../../src/DataSource/duckdb/database.js', () => ({
    getConnection: vi.fn(() => options.connection === false ? null : { query: connectionQuery }),
    setReservedWords: calls.setReservedWords,
  }));

  vi.doMock('../../src/Theme/Theme.js', () => ({ Theme: class Theme {} }));

  const module = await import('../../src/App/App.js');

  return {
    module,
    calls,
    queryHandlers,
    busyHandlers,
    pivotHandlers,
    pivotTableUiMock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('App core initialization and query flows', () => {
  test('getDuckDbLogLevel respects URL param and duckDbRowToJSON serializes BigInt values', async () => {
    const { module } = await loadAppModule({ search: '/?loglevel=DEBUG', connection: false });
    const duckdb = { LogLevel: { INFO: 1, DEBUG: 2 } };

    expect(module.getDuckDbLogLevel(duckdb)).toBe(2);
    expect(JSON.parse(module.duckDbRowToJSON({ toJSON: () => ({ count: 7n }) }))).toEqual({ count: 7 });
  });

  test('initDuckdbVersion populates version info and falls back gracefully on query errors', async () => {
    const success = await loadAppModule();
    success.module.initDuckdbVersion();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.getElementById('duckdbVersionLabel').textContent).toBe('DuckDB v1.2.3, API: wasm');
    expect(success.calls.setReservedWords).toHaveBeenCalledWith(['select', 'from']);

    const failure = await loadAppModule({
      connectionQuery: vi.fn().mockRejectedValue(new Error('network failed')),
    });
    failure.module.initDuckdbVersion();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.getElementById('duckdbVersionLabel').textContent).toBe('DuckDB version unknown');
  });

  test('initApplication wires query updates, run actions, busy state, and postMessage readiness', async () => {
    const { module, calls, queryHandlers, busyHandlers, pivotHandlers, pivotTableUiMock } = await loadAppModule({ autoRunQuery: false });

    module.initApplication();

    expect(calls.initDragableDialogs).toHaveBeenCalledTimes(1);
    expect(calls.initDataSourcesUi).toHaveBeenCalledTimes(1);
    expect(calls.initQueryModel).toHaveBeenCalledTimes(1);
    expect(calls.initQueryUi).toHaveBeenCalledTimes(1);
    expect(calls.initPivotTableUi).toHaveBeenCalledTimes(1);
    expect(calls.setPageState).toHaveBeenCalledWith('#/restored');
    expect(calls.sendReadyMessage).toHaveBeenCalledTimes(1);

    document.getElementById('runQueryButton').click();
    expect(pivotTableUiMock.updatePivotTableUi).toHaveBeenCalledTimes(1);

    const autoRunCheckbox = document.getElementById('autoRunQuery');
    autoRunCheckbox.checked = true;
    autoRunCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.settings.assignSettings).toHaveBeenCalledWith('querySettings', { autoRunQuery: true });
    expect(pivotTableUiMock.updatePivotTableUi).toHaveBeenCalledTimes(2);

    queryHandlers[0]({ eventData: {} });
    expect(document.getElementById('currentDatasource').getAttribute('data-current-datasource')).toBe('Sales datasource');
    expect(document.title).toBe('Huey - Sales Overview');
    expect(calls.updateRouteFromQueryModel).toHaveBeenCalled();

    pivotHandlers.updated({
      eventData: {
        status: 'success',
        tupleCounts: {
          rows: 3,
          columns: 2,
          cells: { axis: 'rows', count: 2 },
        },
        metrics: {
          queryTimeMs: 12,
          renderTimeMs: 6,
          totalTimeMs: 18,
        },
      },
    });
    await Promise.resolve();

    expect(document.getElementById('queryResultRowsInfo').textContent).toBe('#3 × 2');
    expect(document.getElementById('queryResultColumnsInfo').textContent).toBe('#2');
    expect(document.getElementById('queryPerformanceInfo').textContent).toBe('Query: 12ms | Render: 6ms');

    busyHandlers[0]({ eventData: { busy: true } });
    pivotHandlers.progress({ eventData: { message: 'Fetching aggregated cell values...' } });
    expect(document.getElementById('visualizationProgressMessage').textContent).toBe('Fetching aggregated cell values...');
    busyHandlers[0]({ eventData: { busy: false } });
    expect(document.getElementById('visualizationProgressDialog').showModal).toHaveBeenCalledTimes(1);
    expect(document.getElementById('visualizationProgressDialog').close).toHaveBeenCalledTimes(1);
    expect(document.getElementById('visualizationProgressMessage').textContent).toBe('');

    pivotHandlers.updated({ eventData: { status: 'error', error: { title: 'boom' } } });
    expect(calls.showErrorDialog).toHaveBeenCalledWith({ title: 'boom' });
  });
});
