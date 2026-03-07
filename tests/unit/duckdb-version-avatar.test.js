import { afterEach, describe, expect, test, vi } from 'vitest';

function mockAppModuleDependencies(row){
  const query = vi.fn().mockResolvedValue({
    get(index) {
      expect(index).toBe(0);
      return row;
    },
  });
  const setReservedWords = vi.fn();

  vi.doMock('../../src/util/dom/dom.js', () => ({
    byId: (id) => document.getElementById(id),
  }));
  vi.doMock('../../src/util/event/EventBuffer.js', () => ({
    bufferEvents: vi.fn(),
  }));
  vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
    settings: {
      getSettings: () => ({}),
      assignSettings() {},
    },
  }));
  vi.doMock('../../src/util/sql/SQLHelper.js', () => ({
    getQuotedIdentifier: (identifier) => `"${identifier}"`,
    createNumberFormatter: vi.fn(),
  }));
  vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
    showErrorDialog: vi.fn(),
  }));
  vi.doMock('../../src/DragAndDrop/DragableDialogs.js', () => ({
    initDragableDialogs: vi.fn(),
  }));
  vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
    QueryModel: class {},
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
    ExportUi: class {},
    initExportDialog: vi.fn(),
  }));
  vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
    DataSourcesUi: class {},
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
    pivotTableUi: {},
    initPivotTableUi: vi.fn(),
  }));
  vi.doMock('../../src/Routing/Routing.js', () => ({
    Routing: {},
  }));
  vi.doMock('../../src/PageStateManager/PageStateManager.js', () => ({
    pageStateManager: {},
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
    postMessageInterface: {},
    initPostMessageInterface: vi.fn(),
  }));
  vi.doMock('../../src/DataSource/duckdb/database.js', () => ({
    getConnection: () => ({ query }),
    setReservedWords,
  }));
  vi.doMock('../../src/Theme/Theme.js', () => ({
    Theme: {},
  }));

  return { query, setReservedWords };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('initDuckdbVersion', () => {
  test('uses an inline avatar URL instead of a duckdb.org image request', async () => {
    document.body.innerHTML = `
      <a id="duckdbVersionLabel"></a>
      <img id="duckdb-version-specific-avatar" hidden />
    `;

    const { query, setReservedWords } = mockAppModuleDependencies({
      version: 'v1.4.2',
      api: 'wasm',
      reserved_words: '[select,from]',
    });
    const { initDuckdbVersion } = await import('../../src/App/App.js');

    initDuckdbVersion();

    await Promise.resolve();
    await Promise.resolve();

    expect(query).toHaveBeenCalledTimes(1);
    expect(document.getElementById('duckdbVersionLabel').textContent).toBe('DuckDB v1.4.2, API: wasm');

    expect(setReservedWords).toHaveBeenCalledWith(['select', 'from']);

    const avatar = document.getElementById('duckdb-version-specific-avatar');
    expect(avatar.hidden).toBe(false);
    expect(avatar.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(avatar.getAttribute('src')).not.toContain('duckdb.org');
  });
});
