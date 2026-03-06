vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      const defaults = {
        exportUi: { exportDestinationFile: false, exportDestinationClipboard: true },
      };
      return defaults[key] || {};
    },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn(),
}));

vi.mock('../../src/PageStateManager/PageStateManager.js', () => ({
  PageStateManager: class {
    static getPageState() { return {}; }
  },
}));

import {
  datasourceExportMenuId,
  getDownloadMenuHTML,
  getDatasourceExportSettings,
  getCaptionForDatasource,
  sortDatasources,
} from '../../src/DataSource/DataSourceExport.js';
import { DuckDbDataSource } from '../../src/DataSource/duckdb/DuckDbDataSource.js';

describe('DataSourceExport', () => {

  describe('datasourceExportMenuId', () => {
    it('should be the expected string constant', () => {
      expect(datasourceExportMenuId).toBe('datasourceExportMenu');
    });
  });

  describe('getDownloadMenuHTML', () => {
    it('should return HTML string with menu element', () => {
      const html = getDownloadMenuHTML();
      expect(html).toContain('<menu');
      expect(html).toContain(`id="${datasourceExportMenuId}"`);
    });

    it('should include all known file types', () => {
      const html = getDownloadMenuHTML();
      const fileTypes = Object.keys(DuckDbDataSource.fileTypes);
      fileTypes.forEach(type => {
        expect(html).toContain(`value="${type}"`);
      });
    });

    it('should filter out fromFileType when includeFromFileType is false', () => {
      const html = getDownloadMenuHTML('csv', false);
      expect(html).not.toContain('value="csv"');
    });

    it('should include fromFileType when includeFromFileType is not false', () => {
      const html = getDownloadMenuHTML('csv', true);
      expect(html).toContain('value="csv"');
    });

    it('should include fromFileType by default', () => {
      const html = getDownloadMenuHTML('csv');
      expect(html).toContain('value="csv"');
    });
  });

  describe('getDatasourceExportSettings', () => {
    it('should return sqlite export settings', () => {
      const settings = getDatasourceExportSettings('sqlite');
      expect(settings.exportType).toBe('exportSqlite');
      expect(settings.exportSqlite).toBe(true);
      expect(settings.exportDelimited).toBe(false);
      expect(settings.exportDestinationFile).toBe(true);
      expect(settings.exportDestinationClipboard).toBe(false);
    });

    it('should return duckdb export settings', () => {
      const settings = getDatasourceExportSettings('duckdb');
      expect(settings.exportType).toBe('exportDuckdb');
      expect(settings.exportDuckdb).toBe(true);
    });

    it('should return csv export settings', () => {
      const settings = getDatasourceExportSettings('csv');
      expect(settings.exportType).toBe('exportDelimited');
      expect(settings.exportDelimited).toBe(true);
    });

    it('should return parquet export settings', () => {
      const settings = getDatasourceExportSettings('parquet');
      expect(settings.exportType).toBe('exportParquet');
      expect(settings.exportParquet).toBe(true);
    });

    it('should override exportDestination settings from user prefs', () => {
      const settings = getDatasourceExportSettings('csv');
      // Should override the mock settings (clipboard=true → false, file=false → true)
      expect(settings.exportDestinationFile).toBe(true);
      expect(settings.exportDestinationClipboard).toBe(false);
    });
  });

  describe('getCaptionForDatasource', () => {
    function makeDatasource(type, overrides = {}) {
      return {
        getType: () => type,
        getFileNameWithoutExtension: () => overrides.fileName || 'test_file',
        getObjectName: () => overrides.objectName || 'test_table',
        getBaseUrl: () => overrides.baseUrl || 'http://example.com',
        getDatasetId: () => overrides.datasetId || 'dataset1',
        getId: () => overrides.id || 'ds-123',
      };
    }

    it('should return filename for FILE type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.FILE, { fileName: 'sales' });
      expect(getCaptionForDatasource(ds)).toBe('sales');
    });

    it('should return filename for DUCKDB type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.DUCKDB, { fileName: 'mydb' });
      expect(getCaptionForDatasource(ds)).toBe('mydb');
    });

    it('should return filename for SQLITE type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.SQLITE, { fileName: 'app' });
      expect(getCaptionForDatasource(ds)).toBe('app');
    });

    it('should return object name for TABLE type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.TABLE, { objectName: 'users' });
      expect(getCaptionForDatasource(ds)).toBe('users');
    });

    it('should return object name for VIEW type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.VIEW, { objectName: 'v_sales' });
      expect(getCaptionForDatasource(ds)).toBe('v_sales');
    });

    it('should return object name for TABLEFUNCTION type', () => {
      const ds = makeDatasource(DuckDbDataSource.types.TABLEFUNCTION, { objectName: 'fn1' });
      expect(getCaptionForDatasource(ds)).toBe('fn1');
    });

    it('should return baseUrl + datasetId for remote type', () => {
      const ds = makeDatasource('remote', { baseUrl: 'https://api.test', datasetId: 'ds42' });
      expect(getCaptionForDatasource(ds)).toBe('https://api.test — ds42');
    });

    it('should return id for unknown type', () => {
      const ds = makeDatasource('unknown-type', { id: 'custom-id' });
      expect(getCaptionForDatasource(ds)).toBe('custom-id');
    });
  });

  describe('sortDatasources', () => {
    function makeDatasource(type, fileName) {
      return {
        getType: () => type,
        getFileNameWithoutExtension: () => fileName,
        getObjectName: () => fileName,
        getId: () => fileName,
      };
    }

    it('should sort datasources alphabetically by caption', () => {
      const datasources = {
        'ds3': makeDatasource(DuckDbDataSource.types.FILE, 'charlie'),
        'ds1': makeDatasource(DuckDbDataSource.types.FILE, 'alpha'),
        'ds2': makeDatasource(DuckDbDataSource.types.FILE, 'bravo'),
      };
      const sorted = sortDatasources(datasources);
      const keys = Object.keys(sorted);
      expect(keys).toEqual(['ds1', 'ds2', 'ds3']);
    });

    it('should handle empty datasources', () => {
      const sorted = sortDatasources({});
      expect(Object.keys(sorted)).toEqual([]);
    });

    it('should handle single datasource', () => {
      const datasources = {
        'ds1': makeDatasource(DuckDbDataSource.types.FILE, 'only'),
      };
      const sorted = sortDatasources(datasources);
      expect(Object.keys(sorted)).toEqual(['ds1']);
    });
  });
});
