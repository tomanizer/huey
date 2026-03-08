import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../src/SettingsDialog/SettingsDialog.js');
  vi.doUnmock('../../src/QueryModel/QueryModel.js');
  vi.doUnmock('../../src/DataSource/DataSourcesUi.js');
  vi.doUnmock('../../src/DataSource/duckdb/DuckDbDataSource.js');
  vi.doUnmock('../../src/ErrorDialog/ErrorDialog.js');
  vi.doUnmock('../../src/util/clipboard/clipboard.js');
  vi.doUnmock('../../src/util/sql/SQLHelper.js');
  vi.doUnmock('../../src/FilterUi/FilterUi.js');
  vi.doUnmock('../../src/PostMessageInterface/PostMessageInterface.js');
  vi.doUnmock('../../src/Routing/Routing.js');
  document.body.innerHTML = '';
});

describe('module behaviours', () => {
  test('ErrorDialog.getDataFromError extracts message and stack', async () => {
    document.body.innerHTML = `
      <dialog id="errorDialog"></dialog>
      <button id="errorDialogOkButton"></button>
    `;

    const { getDataFromError } = await import('../../src/ErrorDialog/ErrorDialog.js');
    const error = new Error('something broke');

    const data = getDataFromError(error);

    expect(data.title).toBe('something broke');
    expect(data.details).toContain('something broke');
    expect(data.description).toEqual([]);
  });

  test('ExportDialog.formatQueryResultAsCsv escapes quotes and applies null string', async () => {
    vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
      settings: {
        getSettings: () => ({}),
        assignSettings() {},
        addEventListener() {},
        removeEventListener() {},
      },
    }));
    vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
      QueryModel: class {},
      queryModel: {},
    }));
    vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
      DataSourcesUi: class {},
    }));
    vi.doMock('../../src/DataSource/duckdb/DuckDbDataSource.js', () => ({
      DuckDbDataSource: { getFileTypeInfo: () => null },
    }));
    vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
      showErrorDialog: vi.fn(),
    }));
    const { formatQueryResultAsCsv } = await import('../../src/ExportUi/ExportDialog.js');
    const csv = formatQueryResultAsCsv({
      numRows: 1,
      columnNames: ['name', 'note'],
      get(index) {
        if (index === 0) {
          return { name: 'quote', note: 'He said "hello"' };
        }
        return {};
      },
    }, {
      delimiter: ',',
      nullString: '<null>',
      header: true,
      quoteChar: '"',
      escapeChar: '"',
    });

    expect(csv).toContain('name,note');
    expect(csv).toContain('"He said ""hello"""');
  });

  test('FilterDialog static helper classifies range filter type', async () => {
    vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
      settings: {
        getSettings: () => ({}),
        assignSettings() {},
        addEventListener() {},
        removeEventListener() {},
      },
    }));
    vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
      showErrorDialog: vi.fn(),
    }));

    const { FilterDialog } = await import('../../src/FilterUi/FilterUi.js');

    expect(FilterDialog.isRangeFilterType(FilterDialog.filterTypes.BETWEEN)).toBe(true);
    expect(FilterDialog.isRangeFilterType(FilterDialog.filterTypes.INCLUDE)).toBe(false);
  });

  test('Theme.getAllThemeCSSVariables returns only huey CSS variables', async () => {
    vi.doMock('../../src/SettingsDialog/SettingsDialog.js', () => ({
      settings: {
        getSettings: () => ({
          '--huey-foreground-color': '#111111',
        }),
        addEventListener() {},
      },
    }));

    const root = {
      style: {
        '--huey-foreground-color': '#111111',
        '--huey-dark-background-color': '#222222',
        color: '#ffffff',
        setProperty: vi.fn(),
      },
    };
    vi.spyOn(document, 'querySelector').mockReturnValue(root);

    const { Theme } = await import('../../src/Theme/Theme.js');
    const variables = Theme.getAllThemeCSSVariables();

    expect(variables).toEqual({
      '--huey-foreground-color': '#111111',
      '--huey-dark-background-color': '#222222',
    });
  });

  test('SettingsDialog exports locale defaults via settings singleton', async () => {
    localStorage.removeItem('settings');
    document.body.innerHTML = `
      <dialog id="settingsDialog"></dialog>
      <button id="settingsDialogOkButton"></button>
      <button id="settingsDialogCancelButton"></button>
      <button id="settingsDialogResetButton"></button>
      <button id="settingsButton"></button>
    `;

    const { settings } = await import('../../src/SettingsDialog/SettingsDialog.js');
    const locale = settings.getSettings('localeSettings');

    expect(locale).toHaveProperty('minimumIntegerDigits');
    expect(locale).toHaveProperty('maximumFractionDigits');
  });

  test('SessionCloner ignores postMessage events from untrusted origins', async () => {
    document.body.innerHTML = `<button id="cloneHueySession"></button>`;
    const isTrustedOrigin = vi.fn(() => false);
    vi.doMock('../../src/PostMessageInterface/PostMessageInterface.js', () => ({
      PostMessageInterface: { isTrustedOrigin },
      postMessageInterface: {},
      initPostMessageInterface: vi.fn(),
    }));
    vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
      datasourcesUi: {
        getDatasourceIds: () => [],
      },
    }));
    vi.doMock('../../src/Routing/Routing.js', () => ({
      Routing: {
        getCurrentRoute: () => undefined,
      },
    }));

    const { SessionCloner } = await import('../../src/SessionCloner/SessionCloner.js');
    new SessionCloner();

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example',
      data: { messageType: 'anything' },
    }));

    expect(isTrustedOrigin).toHaveBeenCalledWith('https://evil.example');
  });

  test('clipboard.copyToClipboard writes text through navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText,
        write: vi.fn(),
      },
      configurable: true,
    });

    const { copyToClipboard } = await import('../../src/util/clipboard/clipboard.js');
    await copyToClipboard('copied text');

    expect(writeText).toHaveBeenCalledWith('copied text');
  });
});
