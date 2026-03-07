import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  promptShowMock,
  getDatasourceMock,
  isDatasourceCompatibleMock,
} = vi.hoisted(() => ({
  promptShowMock: vi.fn(),
  getDatasourceMock: vi.fn(),
  isDatasourceCompatibleMock: vi.fn(),
}));

vi.mock('../../src/util/dom/dom.js', () => ({
  byId(id) {
    return document.getElementById(id);
  },
  escapeHtmlText(text) {
    return String(text).replace(/[&<>]/g, (match) => {
      switch (match) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        default:
          return match;
      }
    });
  },
}));

vi.mock('../../src/Routing/Routing.js', () => ({
  Routing: {
    getCurrentRoute: () => undefined,
    getRouteForQueryModel: () => undefined,
    getQueryModelStateFromRoute: () => undefined,
    updateRouteFromQueryModel: vi.fn(),
  }
}));

vi.mock('../../src/Internationalization/Internationalization.js', () => ({
  Internationalization: {
    getText(template, ...args) {
      return args.reduce((text, value, index) => {
        return text.replace(`{${index + 1}}`, String(value));
      }, template);
    }
  }
}));

vi.mock('../../src/PromptUi/PromptUi.js', () => ({
  PromptUi: {
    show: promptShowMock,
  }
}));

vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings: () => ({ useLooseColumnTypeComparison: false }),
  }
}));

vi.mock('../../src/QueryModel/QueryModel.js', () => ({
  QueryModel: class {},
  queryModel: {},
}));

vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
  DataSourcesUi: class {
    static getCaptionForDatasource() {
      return 'Compatible datasource';
    }
  },
  datasourcesUi: {
    getDatasource: getDatasourceMock,
    isDatasourceCompatibleWithColumnsSpec: isDatasourceCompatibleMock,
  }
}));

vi.mock('../../src/DataSource/duckdb/DuckDbDataSource.js', () => ({
  DuckDbDataSource: {
    types: { FILE: 'FILE' },
    parseId: () => ({
      type: 'file',
      localId: '<img src=x onerror=1>',
      isUrl: false,
    }),
    getFileNameParts(fileName) {
      return { lowerCaseExtension: fileName.split('.').pop().toLowerCase() };
    }
  }
}));

vi.mock('../../src/DataSourceMenu/DataSourceMenu.js', () => ({
  DataSourceMenu: {
    getDatasourceMenuItemHTML({ value, checked }) {
      return `<input type="radio" name="compatibleDatasources" value="${value}" ${checked ? 'checked' : ''} />`;
    }
  }
}));

vi.mock('../../src/UploadUi/UploadUi.js', () => ({
  uploadUi: {
    uploadFiles: vi.fn(),
    close: vi.fn(),
  }
}));

vi.mock('../../src/AttributeUi/AttributeUi.js', () => ({
  attributeUi: {
    revealAllQueryAttributes: vi.fn(),
  }
}));

vi.mock('../../src/App/analyzeDatasource.js', () => ({
  analyzeDatasource: vi.fn(),
}));

describe('PageStateManager datasource chooser', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="promptUi">
        <input type="radio" name="compatibleDatasources" value="0" checked />
      </div>
      <input id="uploader" />
    `;
    promptShowMock.mockReset();
    getDatasourceMock.mockReset();
    isDatasourceCompatibleMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('escapes dynamic prompt text and supports compatible file datasources', async () => {
    let capturedContents = '';
    promptShowMock.mockImplementation(async ({ contents }) => {
      capturedContents = contents;
      return 'accept';
    });

    const desiredDatasource = { getId: () => 'desired-ds' };
    const compatibleDatasource = {
      getType: () => 'FILE',
      getFileName: () => 'demo.parquet',
    };

    getDatasourceMock.mockImplementation((datasourceId) => {
      if (datasourceId === 'desired-ds') {
        return desiredDatasource;
      }
      return undefined;
    });
    isDatasourceCompatibleMock.mockResolvedValue(['<b>bad</b>']);

    const { PageStateManager } = await import('../../src/PageStateManager/PageStateManager.js');
    const pageStateManager = new PageStateManager();

    const referencedColumns = {
      '<b>bad</b>': { columnType: 'VARCHAR<script>' },
    };

    const result = await pageStateManager.chooseDataSourceForPageStateChangeDialog(
      referencedColumns,
      'desired-ds',
      { compatible: compatibleDatasource },
      [{ getId: () => 'uploaded-ds' }]
    );

    expect(result).toBe(compatibleDatasource);
    expect(capturedContents).toContain('&lt;img src=x onerror=1&gt;');
    expect(capturedContents).toContain('&lt;b&gt;bad&lt;/b&gt; VARCHAR&lt;script&gt;');
    expect(capturedContents).not.toContain('<img src=x onerror=1>');
    expect(capturedContents).not.toContain('<b>bad</b> VARCHAR<script>');
  });
});
