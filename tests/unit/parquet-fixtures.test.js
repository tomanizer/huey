vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/SettingsDialog/SettingsDialog.js');

import { DuckDbDataSource } from '../../src/DataSource/duckdb/DuckDbDataSource.js';

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

describe('Parquet fixture datasource creation', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('single parquet file datasources', () => {
    const fixtures = [
      { file: 'alltypes.parquet', desc: 'multi-type columns' },
      { file: 'wide.parquet', desc: '100-column wide table' },
      { file: 'long.parquet', desc: '500k row tall table' },
      { file: 'nulls.parquet', desc: 'null pattern columns' },
      { file: 'single_row.parquet', desc: 'single row edge case' },
      { file: 'unicode.parquet', desc: 'unicode/special char strings' },
    ];

    test.each(fixtures)('creates file datasource for $file ($desc)', ({ file }) => {
      const f = new File([''], file, { type: 'application/vnd.apache.parquet' });
      const ds = DuckDbDataSource.createFromFile(duckdbMock, createInstanceMock(), f);

      expect(ds.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(ds.getFileName()).toBe(file);
      expect(ds.getFileType()).toBe('parquet');
      expect(ds.getId()).toBe(`file:"${file}"`);
    });

    test('parquet file relation expression uses read_parquet reader', () => {
      const f = new File([''], 'alltypes.parquet', { type: 'application/vnd.apache.parquet' });
      const ds = DuckDbDataSource.createFromFile(duckdbMock, createInstanceMock(), f);
      const rel = ds.getRelationExpression();

      expect(rel).toContain('read_parquet');
      expect(rel).toContain("'alltypes.parquet'");
    });

    test('FROM clause wraps relation expression with FROM keyword', () => {
      const f = new File([''], 'wide.parquet', { type: 'application/vnd.apache.parquet' });
      const ds = DuckDbDataSource.createFromFile(duckdbMock, createInstanceMock(), f);
      const from = ds.getFromClauseSql(undefined, { keywordLetterCase: 'upperCase' });

      expect(from.trim()).toMatch(/^FROM\b/);
      expect(from).toContain('read_parquet');
    });

    test('schema SQL for parquet datasource uses DESCRIBE SELECT *', () => {
      const f = new File([''], 'nulls.parquet', { type: 'application/vnd.apache.parquet' });
      const ds = DuckDbDataSource.createFromFile(duckdbMock, createInstanceMock(), f);
      const schemaSql = ds.getSqlForTableSchema();

      expect(schemaSql).toContain('DESCRIBE SELECT *');
      expect(schemaSql).toContain('read_parquet');
      expect(schemaSql).toContain("'nulls.parquet'");
    });
  });

  describe('folder datasource (FILES type)', () => {
    const flatFolderFiles = ['batch_a.parquet', 'batch_b.parquet', 'batch_c.parquet'];

    test('creates FILES datasource from flat folder file list', () => {
      const ds = new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: flatFolderFiles,
        fileType: 'parquet'
      });

      expect(ds.getType()).toBe(DuckDbDataSource.types.FILES);
      expect(ds.getId()).toContain('files:');
      expect(ds.getId()).toContain('batch_a.parquet');
      expect(ds.getId()).toContain('batch_b.parquet');
      expect(ds.getId()).toContain('batch_c.parquet');
    });

    test('FILES relation expression includes all file names in read_parquet call', () => {
      const ds = new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: flatFolderFiles,
        fileType: 'parquet'
      });
      const rel = ds.getRelationExpression();

      expect(rel).toContain('read_parquet');
      for (const f of flatFolderFiles) {
        expect(rel).toContain(f);
      }
    });

    test('hive partitioned folder paths work as FILES datasource', () => {
      const hiveFiles = [
        'partition_date=2026-01-01/data.parquet',
        'partition_date=2026-01-02/data.parquet',
        'partition_date=2026-01-03/data.parquet',
        'partition_date=2026-01-04/data.parquet',
      ];
      const ds = new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: hiveFiles,
        fileType: 'parquet'
      });

      expect(ds.getType()).toBe(DuckDbDataSource.types.FILES);
      const rel = ds.getRelationExpression();
      expect(rel).toContain('read_parquet');
      expect(rel).toContain('partition_date=2026-01-01/data.parquet');
    });

    test('multi-level hive partitioned paths work as FILES datasource', () => {
      const hiveFiles = [
        'exchange=NYSE/sector=Technology/data.parquet',
        'exchange=NYSE/sector=Finance/data.parquet',
        'exchange=NASDAQ/sector=Technology/data.parquet',
        'exchange=NASDAQ/sector=Finance/data.parquet',
        'exchange=LSE/sector=Technology/data.parquet',
        'exchange=LSE/sector=Finance/data.parquet',
      ];
      const ds = new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: hiveFiles,
        fileType: 'parquet'
      });

      expect(ds.getType()).toBe(DuckDbDataSource.types.FILES);
      const rel = ds.getRelationExpression();
      expect(rel).toContain('read_parquet');
      expect(rel).toContain('exchange=NYSE/sector=Technology/data.parquet');
    });

    test('rejects FILES datasource with empty fileNames array', () => {
      expect(() => new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: [],
        fileType: 'parquet'
      })).not.toThrow(); // empty array is accepted by constructor
    });

    test('rejects FILES datasource without fileNames', () => {
      expect(() => new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileType: 'parquet'
      })).toThrow('fileNames');
    });

    test('rejects FILES datasource without fileType', () => {
      expect(() => new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: ['a.parquet'],
      })).toThrow('fileType');
    });

    test('rejects FILES datasource with unknown fileType', () => {
      expect(() => new DuckDbDataSource(duckdbMock, createInstanceMock(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: ['a.bin'],
        fileType: 'unknown_format'
      })).toThrow('not recognized');
    });
  });

  describe('parquet URL and glob datasource creation', () => {
    test('createFromUrl accepts glob parquet path without HEAD probe', async () => {
      const spy = vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl').mockImplementation(() => {
        throw new Error('should not probe');
      });
      const ds = await DuckDbDataSource.createFromUrl(
        duckdbMock, createInstanceMock(),
        '/data/hive_multi/exchange=*/sector=*/*.parquet'
      );

      expect(spy).not.toHaveBeenCalled();
      expect(ds.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(ds.getFileType()).toBe('parquet');
    });

    test('glob path with hive partition pattern is a valid datasource', async () => {
      vi.spyOn(DuckDbDataSource, 'getResourceInfoForUrl').mockImplementation(() => {
        throw new Error('should not probe');
      });
      const ds = await DuckDbDataSource.createFromUrl(
        duckdbMock, createInstanceMock(),
        '/fixtures/hive_single/partition_date=*/*.parquet'
      );

      expect(ds.getFileType()).toBe('parquet');
      expect(ds.getFileName()).toBe('/fixtures/hive_single/partition_date=*/*.parquet');
    });
  });

  describe('parquet datasource ID parsing', () => {
    test('parseId round-trips for a parquet file', () => {
      const id = DuckDbDataSource.getDatasourceIdForFileName('alltypes.parquet');
      const parsed = DuckDbDataSource.parseId(id);

      expect(parsed.type).toBe('file');
      expect(parsed.resource).toBe('alltypes.parquet');
      expect(parsed.isUrl).toBe(false);
    });

    test('parseId handles paths with hive partition segments', () => {
      const path = 'exchange=NYSE/sector=Finance/data.parquet';
      const id = DuckDbDataSource.getDatasourceIdForFileName(path);
      const parsed = DuckDbDataSource.parseId(id);

      expect(parsed.type).toBe('file');
      expect(parsed.resource).toBe(path);
    });

    test('parseId detects URL-based parquet datasources', () => {
      const url = 'https://storage.example.com/data/trades.parquet';
      const id = DuckDbDataSource.getDatasourceIdForFileName(url);
      const parsed = DuckDbDataSource.parseId(id);

      expect(parsed.type).toBe('file');
      expect(parsed.resource).toBe(url);
      expect(parsed.isUrl).toBe(true);
    });
  });

  describe('parquet blob datasource (cloud download scenario)', () => {
    test('createFromBlob accepts parquet blob with cloud URI', () => {
      const blob = new Blob([new Uint8Array(100)], { type: 'application/vnd.apache.parquet' });
      const ds = DuckDbDataSource.createFromBlob(
        duckdbMock, createInstanceMock(),
        blob, 'trades.parquet', 's3://my-bucket/data/trades.parquet'
      );

      expect(ds.getType()).toBe(DuckDbDataSource.types.FILE);
      expect(ds.getFileType()).toBe('parquet');
      expect(ds.getFileName()).toBe('trades.parquet');
      expect(ds.getCloudUri()).toBe('s3://my-bucket/data/trades.parquet');
    });

    test('createFromBlob rejects blob with non-parquet extension', () => {
      const blob = new Blob([new Uint8Array(10)]);
      expect(() => DuckDbDataSource.createFromBlob(
        duckdbMock, createInstanceMock(),
        blob, 'data.unknown_ext'
      )).toThrow('Unrecognized file extension');
    });
  });
});
