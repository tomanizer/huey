vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/SettingsDialog/SettingsDialog.js');

import { DuckDbDataSource } from '../../src/DataSource/duckdb/DuckDbDataSource.js';
import { showErrorDialog } from '../../src/ErrorDialog/ErrorDialog.js';

describe('DuckDbDataSource logic coverage', () => {
  const duckdbMock = {
    DuckDBDataProtocol: {
      HTTP: 'HTTP',
      BROWSER_FILEREADER: 'BROWSER_FILEREADER'
    }
  };

  function createInstanceMock(overrides = {}) {
    const query = vi.fn();
    const connection = {
      query,
      close: vi.fn(),
      prepare: vi.fn()
    };
    return {
      registerFileHandle: vi.fn(),
      exportFileStatistics: vi.fn(),
      connect: vi.fn().mockResolvedValue(connection),
      dropFile: vi.fn(),
      ...overrides,
      __connection: connection,
      __query: query
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('static file helpers', () => {
    it('parses file names with multiple dots and mixed-case extensions', () => {
      const result = DuckDbDataSource.getFileNameParts('data.backup.CSV');
      expect(result).toEqual({
        extension: 'CSV',
        lowerCaseExtension: 'csv',
        fileNameWithoutExtension: 'data.backup'
      });
    });

    it('returns undefined for names without an extension', () => {
      expect(DuckDbDataSource.getFileNameParts('folder/README')).toBeUndefined();
    });

    it('returns type info for supported file types and undefined for unknown type', () => {
      ['csv', 'tsv', 'txt', 'json', 'jsonl', 'parquet', 'xlsx', 'duckdb', 'sqlite'].forEach((fileType) => {
        expect(DuckDbDataSource.getFileTypeInfo(fileType)).toBe(DuckDbDataSource.fileTypes[fileType]);
      });
      expect(DuckDbDataSource.getFileTypeInfo('nope')).toBeUndefined();
    });
  });

  describe('factory methods', () => {
    it('createFromFile rejects non-File input', () => {
      expect(() => DuckDbDataSource.createFromFile(duckdbMock, {}, { name: 'data.csv' }))
        .toThrow('The file argument must be an instance of File');
    });

    it('createFromFile builds a file datasource for known file types', () => {
      const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
      const datasource = DuckDbDataSource.createFromFile(duckdbMock, createInstanceMock(), file);

      expect(datasource.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(datasource.getFileName()).toBe('data.csv');
      expect(datasource.getFileType()).toBe('csv');
      expect(datasource.getId()).toBe('file:"data.csv"');
    });

    it('createFromBlob stores cloudUri separately from physical filename', () => {
      const blob = new Blob(['{}'], { type: 'application/json' });
      const datasource = DuckDbDataSource.createFromBlob(
        duckdbMock,
        createInstanceMock(),
        blob,
        'data.json',
        's3://bucket/path/data.json'
      );

      expect(datasource.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(datasource.getFileName()).toBe('data.json');
      expect(datasource.getObjectName()).toBe('s3://bucket/path/data.json');
      expect(datasource.getFileType()).toBe('json');
    });

    it('createFromBlob rejects unknown extension in fileName', () => {
      const blob = new Blob(['x']);
      expect(() => DuckDbDataSource.createFromBlob(duckdbMock, createInstanceMock(), blob, 'data.unknown'))
        .toThrow('Unrecognized file extension "unknown"');
    });

    it('createFromUrl supports glob parquet paths without probing headers', async () => {
      const resourceSpy = vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl').mockImplementation(() => {
        throw new Error('Unexpected call to getResourceInfoForUrl');
      });
      const datasource = await DuckDbDataSource.createFromUrl(
        duckdbMock,
        createInstanceMock(),
        'https://example.org/data/*/*.parquet?token=abc'
      );

      expect(resourceSpy).not.toHaveBeenCalled();
      expect(datasource.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(datasource.getFileType()).toBe('parquet');
      expect(datasource.getFileName()).toBe('https://example.org/data/*/*.parquet?token=abc');
    });

    it('createFromUrl maps content type from HEAD response', async () => {
      vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl').mockResolvedValue({
        headers: {
          'content-type': 'text/csv; charset=utf-8'
        }
      });

      const datasource = await DuckDbDataSource.createFromUrl(
        duckdbMock,
        createInstanceMock(),
        'https://example.org/data.csv'
      );

      expect(datasource.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(datasource.getFileType()).toBe('csv');
    });

    it('createFromUrl detects sqlite file signatures when HEAD content-type is inconclusive', async () => {
      vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl')
      .mockResolvedValueOnce({
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes'
        }
      })
      .mockResolvedValueOnce({
        responseText: 'SQLite format 3\0rest',
        headers: {}
      });

      const datasource = await DuckDbDataSource.createFromUrl(
        duckdbMock,
        createInstanceMock(),
        'https://example.org/database.bin'
      );

      expect(datasource.getType()).toBe(DuckDbDataSource.types.SQLITE);
      expect(datasource.getFileName()).toBe('https://example.org/database.bin');
    });
  });

  describe('identifier and SQL helpers', () => {
    it('builds and parses datasource ids for quoted file names and URLs', () => {
      const localId = DuckDbDataSource.getDatasourceIdForFileName('folder/data.csv');
      const urlId = DuckDbDataSource.getDatasourceIdForFileName('https://example.org/data.parquet');

      expect(DuckDbDataSource.parseId(localId)).toEqual({
        type: 'file',
        localId: '"folder/data.csv"',
        isUrl: false,
        resource: 'folder/data.csv'
      });
      expect(DuckDbDataSource.parseId(urlId)).toEqual({
        type: 'file',
        localId: '"https://example.org/data.parquet"',
        isUrl: true,
        resource: 'https://example.org/data.parquet'
      });
    });

    it('generates relation and schema SQL for file, table, and sqlquery sources', () => {
      const fileDs = DuckDbDataSource.createFromFile(
        duckdbMock,
        createInstanceMock(),
        new File(['a,b\n1,2'], 'source.csv', { type: 'text/csv' })
      );
      const tableDs = new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.TABLE,
        catalogName: 'memory',
        schemaName: 'main',
        tableName: 'orders'
      });
      const sqlDs = DuckDbDataSource.createFromSql(duckdbMock, createInstanceMock(), 'select 1 as one');

      expect(fileDs.getRelationExpression('src')).toContain("read_csv( 'source.csv'");
      expect(fileDs.getFromClauseSql()).toContain("read_csv( 'source.csv'");
      expect(fileDs.getSqlForTableSchema()).toContain("DESCRIBE SELECT *");
      expect(fileDs.getSqlForTableSchema()).toContain("read_csv( 'source.csv'");

      expect(tableDs.getRelationExpression()).toBe('memory.main.orders');
      const fromClause = tableDs.getFromClauseSql(undefined, { keywordLetterCase: 'upperCase' });
      expect(fromClause).toContain('memory.main.orders');
      expect(fromClause.trim()).toMatch(/^FROM\b/);

      expect(sqlDs.getRelationExpression()).toBe('( select 1 as one )');
    });
  });

  describe('column metadata', () => {
    it('registers file once and caches metadata query result', async () => {
      const instance = createInstanceMock();
      const metadata = {
        readRows: vi.fn().mockReturnValue([])
      };
      instance.__query.mockResolvedValue(metadata);

      const datasource = DuckDbDataSource.createFromFile(
        duckdbMock,
        instance,
        new File(['a,b\n1,2'], 'people.csv', { type: 'text/csv' })
      );

      const first = await datasource.getColumnMetadata();
      const second = await datasource.getColumnMetadata();

      expect(first).toBe(metadata);
      expect(second).toBe(metadata);
      expect(instance.connect).toHaveBeenCalledTimes(1);
      expect(instance.registerFileHandle).toHaveBeenCalledTimes(1);
      expect(instance.__query).toHaveBeenCalledTimes(1);
      expect(instance.__query.mock.calls[0][0]).toContain('DESCRIBE SELECT *');
      expect(instance.__query.mock.calls[0][0]).toContain("read_csv( 'people.csv'");
    });

    it('shows an error dialog and rethrows when metadata query fails', async () => {
      const instance = createInstanceMock();
      const error = new Error('describe failed');
      instance.__query.mockRejectedValue(error);

      const datasource = DuckDbDataSource.createFromFile(
        duckdbMock,
        instance,
        new File(['a,b\n1,2'], 'broken.csv', { type: 'text/csv' })
      );

      await expect(datasource.getColumnMetadata()).rejects.toThrow('describe failed');
      expect(showErrorDialog).toHaveBeenCalledWith(error);
    });

    it('reuses cached parquet metadata across datasource instances with the same file fingerprint', async () => {
      const file = new File(['parquet'], 'people.parquet', { type: 'application/vnd.apache.parquet', lastModified: 1234 });

      const firstInstance = createInstanceMock();
      const firstMetadata = {
        numRows: 1,
        schema: { fields: [{ name: 'column_name' }, { name: 'column_type' }] },
        get() {
          return {
            column_name: 'id',
            column_type: 'BIGINT',
            toJSON() {
              return { column_name: 'id', column_type: 'BIGINT' };
            }
          };
        }
      };
      firstInstance.__query.mockResolvedValue(firstMetadata);

      const firstDatasource = DuckDbDataSource.createFromFile(duckdbMock, firstInstance, file);
      const cacheKey = firstDatasource.getColumnMetadataCacheKey();
      expect(cacheKey).toBeTruthy();
      await firstDatasource.getColumnMetadata();
      expect(firstInstance.__query).toHaveBeenCalledTimes(1);

      const secondInstance = createInstanceMock();
      const secondDatasource = DuckDbDataSource.createFromFile(duckdbMock, secondInstance, file);
      const cachedMetadata = await secondDatasource.getColumnMetadata();

      expect(secondInstance.__query).not.toHaveBeenCalled();
      expect(cachedMetadata.numRows).toBe(1);
      expect(cachedMetadata.get(0).column_name).toBe('id');
      expect(cachedMetadata.get(0).column_type).toBe('BIGINT');
      expect(cachedMetadata.schema.fields.map((field) => field.name)).toEqual(['column_name', 'column_type']);
    });

    it('does not create a persistent cache key for non-parquet files', () => {
      const datasource = DuckDbDataSource.createFromFile(
        duckdbMock,
        createInstanceMock(),
        new File(['a,b\n1,2'], 'people.csv', { type: 'text/csv' })
      );

      expect(datasource.getColumnMetadataCacheKey()).toBeUndefined();
    });
  });
});
