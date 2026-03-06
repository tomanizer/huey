vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
  datasourcesUi: { addDatasources: vi.fn() }
}));

vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings() { return {}; },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn()
}));

vi.mock('../../src/PageStateManager/PageStateManager.js', () => ({
  pageStateManager: { setPageState: vi.fn() }
}));

vi.mock('../../src/App/analyzeDatasource.js', () => ({
  analyzeDatasource: vi.fn()
}));

vi.mock('../../src/PromptUi/PromptUi.js', () => ({
  PromptUi: { show: vi.fn() }
}));

vi.mock('../../src/QueryModel/QueryModel.js', () => ({
  queryModel: {}
}));

import { DatasourceSettings } from '../../src/DatasourceSettingsDialog/DatasourceSettings.js';
import { DuckDbDataSource } from '../../src/DataSource/duckdb/DuckDbDataSource.js';
import { getUrlsFromInput, isParquetUrl } from '../../src/UploadUi/UploadUi.js';

describe('Parquet support settings', () => {
  test('maps parquet hive partitioning setting to duckdb reader argument', () => {
    const settings = new DatasourceSettings();
    const nextSettings = settings.getSettings();
    nextSettings.parquetReader.parquetReaderHivePartitioning = true;
    settings.assignSettings([], nextSettings);

    const readerArguments = settings.getReaderArguments('read_parquet');

    expect(readerArguments).toEqual({ hive_partitioning: true });
  });
});

describe('Upload URL parsing helpers', () => {
  test('parses comma/newline-separated URL input', () => {
    const urls = getUrlsFromInput('https://a/x.parquet, https://b/y.parquet\nhttps://c/z.parquet');
    expect(urls).toEqual([
      'https://a/x.parquet',
      'https://b/y.parquet',
      'https://c/z.parquet'
    ]);
  });

  test('detects parquet urls with optional querystring', () => {
    expect(isParquetUrl('https://example.org/data/file.parquet')).toBe(true);
    expect(isParquetUrl('https://example.org/data/file.parquet?token=x')).toBe(true);
    expect(isParquetUrl('not a valid url but parquet.parquet?token=x')).toBe(true);
    expect(isParquetUrl('https://example.org/data/file.csv')).toBe(false);
    expect(isParquetUrl('not a valid url and not parquet')).toBe(false);
  });
});

describe('Parquet glob datasource creation', () => {
  test('createFromUrl accepts parquet glob path without HEAD probing', async () => {
    const getResourceInfoSpy = vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl');
    const datasource = await DuckDbDataSource.createFromUrl(
      {},
      {},
      '/dataset/*/*/*.parquet'
    );

    expect(getResourceInfoSpy).not.toHaveBeenCalled();
    expect(datasource.getType()).toBe(DuckDbDataSource.types.FILE);
    expect(datasource.getFileType()).toBe('parquet');
    expect(datasource.getFileName()).toBe('/dataset/*/*/*.parquet');
  });
});
