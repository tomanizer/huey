import {
  datasourceTypes,
  fileTypeDefinitions,
  readerArguments,
  getFileNameParts,
  getFileTypeInfo,
  globPathPattern,
} from '../../src/DataSource/duckdb/DuckDbDataSourceConfig.js';

describe('DuckDbDataSourceConfig', () => {

  describe('datasourceTypes', () => {
    it('should export all expected datasource type constants', () => {
      expect(datasourceTypes.DUCKDB).toBe('duckdb');
      expect(datasourceTypes.FILE).toBe('file');
      expect(datasourceTypes.FILES).toBe('files');
      expect(datasourceTypes.SQLITE).toBe('sqlite');
      expect(datasourceTypes.SQLQUERY).toBe('sql');
      expect(datasourceTypes.TABLE).toBe('table');
      expect(datasourceTypes.TABLEFUNCTION).toBe('table function');
      expect(datasourceTypes.URL).toBe('url');
      expect(datasourceTypes.VIEW).toBe('view');
    });
  });

  describe('fileTypeDefinitions', () => {
    it('should define csv with read_csv reader', () => {
      const csv = fileTypeDefinitions['csv'];
      expect(csv).toBeDefined();
      expect(csv.datasourceType).toBe(datasourceTypes.FILE);
      expect(csv.duckdb_reader).toBe('read_csv');
      expect(csv.duckdb_sniffer).toBe('sniff_csv');
      expect(csv.mimeType).toBe('text/csv');
    });

    it('should define tsv with read_csv reader', () => {
      const tsv = fileTypeDefinitions['tsv'];
      expect(tsv).toBeDefined();
      expect(tsv.duckdb_reader).toBe('read_csv');
    });

    it('should define json with read_json_auto reader', () => {
      const json = fileTypeDefinitions['json'];
      expect(json).toBeDefined();
      expect(json.duckdb_reader).toBe('read_json_auto');
      expect(json.duckdb_extension).toBe('json');
    });

    it('should define parquet with read_parquet reader', () => {
      const parquet = fileTypeDefinitions['parquet'];
      expect(parquet).toBeDefined();
      expect(parquet.duckdb_reader).toBe('read_parquet');
      expect(parquet.mimeType).toBe('application/vnd.apache.parquet');
    });

    it('should define xlsx with read_xlsx reader and excel extension', () => {
      const xlsx = fileTypeDefinitions['xlsx'];
      expect(xlsx).toBeDefined();
      expect(xlsx.duckdb_reader).toBe('read_xlsx');
      expect(xlsx.duckdb_extension).toBe('excel');
    });

    it('should define duckdb as DUCKDB datasource type', () => {
      const duckdb = fileTypeDefinitions['duckdb'];
      expect(duckdb).toBeDefined();
      expect(duckdb.datasourceType).toBe(datasourceTypes.DUCKDB);
    });

    it('should define sqlite with sqlite_scanner extension', () => {
      const sqlite = fileTypeDefinitions['sqlite'];
      expect(sqlite).toBeDefined();
      expect(sqlite.datasourceType).toBe(datasourceTypes.SQLITE);
      expect(sqlite.duckdb_extension).toBe('sqlite_scanner');
    });

    it('should have entries for all expected file types', () => {
      const expectedTypes = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'parquet', 'xlsx', 'duckdb', 'sqlite'];
      expectedTypes.forEach(type => {
        expect(fileTypeDefinitions[type]).toBeDefined();
      });
    });
  });

  describe('readerArguments', () => {
    it('should define read_csv arguments', () => {
      expect(readerArguments.read_csv).toBeDefined();
      expect(readerArguments.read_csv.store_rejects).toBe(false);
    });

    it('should define sniff_csv arguments', () => {
      expect(readerArguments.sniff_csv).toBeDefined();
      expect(readerArguments.sniff_csv.sample_size).toBe(20480);
    });

    it('should define read_json_auto arguments', () => {
      expect(readerArguments.read_json_auto).toBeDefined();
      expect(readerArguments.read_json_auto.ignore_errors).toBe(true);
      expect(readerArguments.read_json_auto.maximum_object_size).toBe(16777216);
    });
  });

  describe('getFileNameParts', () => {
    it('should parse a simple filename', () => {
      const result = getFileNameParts('data.csv');
      expect(result.extension).toBe('csv');
      expect(result.lowerCaseExtension).toBe('csv');
      expect(result.fileNameWithoutExtension).toBe('data');
    });

    it('should handle uppercase extensions', () => {
      const result = getFileNameParts('data.CSV');
      expect(result.extension).toBe('CSV');
      expect(result.lowerCaseExtension).toBe('csv');
      expect(result.fileNameWithoutExtension).toBe('data');
    });

    it('should handle filenames with multiple dots', () => {
      const result = getFileNameParts('my.data.file.parquet');
      expect(result.extension).toBe('parquet');
      expect(result.fileNameWithoutExtension).toBe('my.data.file');
    });

    it('should return undefined for filenames without extension', () => {
      expect(getFileNameParts('noextension')).toBeUndefined();
    });

    it('should handle File objects', () => {
      const file = new File([''], 'test.json', { type: 'application/json' });
      const result = getFileNameParts(file);
      expect(result.extension).toBe('json');
      expect(result.fileNameWithoutExtension).toBe('test');
    });
  });

  describe('getFileTypeInfo', () => {
    it('should return file type info for known types', () => {
      expect(getFileTypeInfo('csv')).toBe(fileTypeDefinitions['csv']);
      expect(getFileTypeInfo('parquet')).toBe(fileTypeDefinitions['parquet']);
    });

    it('should return undefined for unknown types', () => {
      expect(getFileTypeInfo('unknown')).toBeUndefined();
    });
  });

  describe('globPathPattern', () => {
    it('should match glob characters', () => {
      expect(globPathPattern.test('*.csv')).toBe(true);
      expect(globPathPattern.test('data?.csv')).toBe(true);
      expect(globPathPattern.test('[a-z].csv')).toBe(true);
    });

    it('should not match plain filenames', () => {
      expect(globPathPattern.test('data.csv')).toBe(false);
      expect(globPathPattern.test('path/to/file.parquet')).toBe(false);
    });
  });
});
