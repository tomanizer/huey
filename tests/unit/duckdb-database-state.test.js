import {
  getConnection,
  getDatabase,
  getDuckDbModule,
  getReservedWords,
  setDatabase,
  setReservedWords,
} from '../../src/DataSource/duckdb/database.js';

describe('duckdb database state module', () => {
  test('stores and returns database state values', () => {
    const duckdbModule = { DuckDBDataProtocol: { BROWSER_FILEREADER: 1 } };
    const database = { connect: vi.fn() };
    const connection = { query: vi.fn() };

    setDatabase(duckdbModule, database, connection);

    expect(getDuckDbModule()).toBe(duckdbModule);
    expect(getDatabase()).toBe(database);
    expect(getConnection()).toBe(connection);
  });

  test('defaults reserved words to an empty list when invalid input is set', () => {
    setReservedWords(['select', 'from']);
    expect(getReservedWords()).toEqual(['select', 'from']);

    setReservedWords(null);
    expect(getReservedWords()).toEqual([]);
  });
});
