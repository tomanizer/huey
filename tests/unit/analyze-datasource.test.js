import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../src/Tabs/Tabs.js');
  vi.doUnmock('../../src/Search/Search.js');
  vi.doUnmock('../../src/UploadUi/UploadUi.js');
  vi.doUnmock('../../src/QueryModel/QueryModel.js');
  vi.doUnmock('../../src/AttributeUi/AttributeUi.js');
  vi.doUnmock('../../src/ErrorDialog/ErrorDialog.js');
});

describe('analyzeDatasource', () => {
  test('does not close the upload dialog when it is already closed', async () => {
    const close = vi.fn(() => {
      throw new Error('close should not be called');
    });
    const setDatasource = vi.fn();

    vi.doMock('../../src/Tabs/Tabs.js', () => ({
      TabUi: { setSelectedTab: vi.fn() },
    }));
    vi.doMock('../../src/Search/Search.js', () => ({
      clearSearch: vi.fn(),
    }));
    vi.doMock('../../src/UploadUi/UploadUi.js', () => ({
      uploadUi: {
        getDialog: () => ({ open: false, close }),
      }
    }));
    vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
      queryModel: { setDatasource },
    }));
    vi.doMock('../../src/AttributeUi/AttributeUi.js', () => ({
      attributeUi: { clear: vi.fn() },
    }));
    vi.doMock('../../src/ErrorDialog/ErrorDialog.js', () => ({
      showErrorDialog: vi.fn(),
    }));

    const { analyzeDatasource } = await import('../../src/App/analyzeDatasource.js');
    const datasource = { getId: () => 'demo' };

    await expect(analyzeDatasource(datasource)).resolves.toBeUndefined();
    expect(setDatasource).toHaveBeenCalledWith(datasource);
    expect(close).not.toHaveBeenCalled();
  });
});
