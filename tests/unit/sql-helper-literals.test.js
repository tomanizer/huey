vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      if (key === 'localeSettings') {
        return { locale: ['en-GB'], nullString: 'NULL', minimumIntegerDigits: 1, minimumFractionDigits: 0, maximumFractionDigits: 3, linkMinimumAndMaximumDecimals: false };
      }
      if (key === 'sqlSettings') {
        return { alwaysQuoteIdentifiers: false, commaStyle: 'spaceAfter', keywordLetterCase: 'upperCase' };
      }
      return {};
    },
  },
}));

vi.mock('../../src/DataSource/duckdb/database.js', () => ({
  getReservedWords: () => ['select', 'from'],
}));

import {
  dataTypes,
  getArrowDecimalAsString,
  getDuckDbLiteralForValue,
  quoteStringLiteral,
  isQuoted,
  unQuote,
  getQuotedIdentifier,
  getIdentifier,
  identifierRequiresQuoting,
  quoteIdentifierWhenRequired,
  getQualifiedIdentifier,
  getCopyToStatement,
  getComma,
  normalizeSqlOptions,
  getSqlValuesClause,
  getStructTypeDescriptor,
  getMapKeyValueType,
  getMapKeyType,
  getMapValueType,
  getMapEntryType,
  getMapEntriesType,
  getArrayElementType,
  getArrayType,
  isArrayType,
  isMapType,
  isStructType,
  isStringType,
  getMemberExpressionType,
  extrapolateColumnExpression,
  getUsingSampleClause,
  getMedianReturnDataTypeForArgumentDataType,
} from '../../src/util/sql/SQLHelper.js';

describe('SQLHelper literal writers', () => {
  test('VARCHAR literal writer quotes values and renders typed NULL', () => {
    const writer = dataTypes['VARCHAR'].createLiteralWriter();
    expect(writer('hello')).toBe('\'hello\'');
    expect(writer('\'hello\'')).toBe('\'\'\'hello\'\'\'');
    expect(writer(null)).toBe('NULL::VARCHAR');
  });

  test('INTEGER and BIGINT literal writers render typed values and NULL', () => {
    const integerWriter = dataTypes['INTEGER'].createLiteralWriter();
    const bigintWriter = dataTypes['BIGINT'].createLiteralWriter();

    expect(integerWriter(42)).toBe('42::INTEGER');
    expect(bigintWriter(42)).toBe('42::BIGINT');
    expect(integerWriter(null)).toBe('NULL::INTEGER');
    expect(bigintWriter(null)).toBe('NULL::BIGINT');
  });

  test('BOOLEAN literal writer renders true/false and typed NULL', () => {
    const writer = dataTypes['BOOLEAN'].createLiteralWriter();
    expect(writer(true)).toBe('true');
    expect(writer(false)).toBe('false');
    expect(writer(null)).toBe('NULL::BOOLEAN');
  });

  test('DATE and TIMESTAMP literal writers render values and typed NULL', () => {
    const dateWriter = dataTypes['DATE'].createLiteralWriter();
    const timestampWriter = dataTypes['TIMESTAMP'].createLiteralWriter();

    expect(dateWriter('2024-01-15')).toBe('DATE\'2024-01-15\'');
    expect(dateWriter(null)).toBe('NULL::DATE');

    expect(timestampWriter(1705276800000)).toBe('to_timestamp( 1705276800000::DOUBLE / 1000 )');
    expect(timestampWriter(null)).toBe('NULL::TIMESTAMP');
  });

  test('DECIMAL literal writer renders DECIMAL(p,s) literals and invalid type throws', () => {
    const writer = dataTypes['DECIMAL'].createLiteralWriter({}, 'DECIMAL(10,2)');
    expect(writer('123456', { type: { scale: 2 } })).toBe('1234.56::DECIMAL(10,2)');

    expect(() => dataTypes['DECIMAL'].createLiteralWriter({}, 'DECIMAL')).toThrow(
      'Couldn\'t match DECIMAL against regex for DECIMAL'
    );
  });

  test('DECIMAL literal writer remains locale-independent', () => {
    const numberFormatSpy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => ({
      format: () => '1.234,56',
    }));
    try {
      const writer = dataTypes['DECIMAL'].createLiteralWriter({}, 'DECIMAL(10,2)');
      expect(writer('123456', { type: { scale: 2 } })).toBe('1234.56::DECIMAL(10,2)');
    }
    finally {
      numberFormatSpy.mockRestore();
    }
  });
});

describe('SQLHelper dataTypes metadata', () => {
  test('defaultAnalyticalRole values are valid', () => {
    const missingRole = [];
    for (const [name, info] of Object.entries(dataTypes)) {
      if (Object.hasOwn(info, 'defaultAnalyticalRole')) {
        expect(['attribute', 'measure']).toContain(info.defaultAnalyticalRole);
      }
      else {
        missingRole.push(name);
      }
    }
    expect(missingRole).toEqual([]);
  });

  test('numeric, integer, unsigned flags and precision alternatives are consistent', () => {
    expect(dataTypes['DECIMAL'].isNumeric).toBe(true);
    expect(dataTypes['DECIMAL'].isInteger).toBeUndefined();
    expect(dataTypes['BOOLEAN'].isNumeric).toBeUndefined();

    expect(dataTypes['INTEGER'].isNumeric).toBe(true);
    expect(dataTypes['INTEGER'].isInteger).toBe(true);
    expect(dataTypes['INTEGER'].isUnsigned).toBeUndefined();

    expect(dataTypes['UINTEGER'].isNumeric).toBe(true);
    expect(dataTypes['UINTEGER'].isInteger).toBe(true);
    expect(dataTypes['UINTEGER'].isUnsigned).toBe(true);

    expect(dataTypes['TINYINT'].greaterPrecisionAlternative).toBe('SMALLINT');
    expect(dataTypes['SMALLINT'].greaterPrecisionAlternative).toBe('INTEGER');
    expect(dataTypes['INTEGER'].greaterPrecisionAlternative).toBe('BIGINT');
    expect(dataTypes['BIGINT'].greaterPrecisionAlternative).toBe('HUGEINT');
    expect(dataTypes['HUGEINT'].greaterPrecisionAlternative).toBeUndefined();
  });
});

describe('SQLHelper getDuckDbLiteralForValue', () => {
  test('renders supported arrow types', () => {
    expect(getDuckDbLiteralForValue(42, { typeId: -5 })).toBe('42');
    expect(getDuckDbLiteralForValue(true, { typeId: 6 })).toBe('true');
    expect(getDuckDbLiteralForValue('hello', { typeId: 5 })).toBe('\'hello\'');
    expect(getDuckDbLiteralForValue(1705276800000, { typeId: 10 })).toBe('to_timestamp( 1705276800000::DOUBLE / 1000)');
    expect(getDuckDbLiteralForValue('123456', { typeId: 7, scale: 2 })).toBe('1234.56::DECIMAL');
    expect(getDuckDbLiteralForValue(new Date('2024-01-15T00:00:00Z'), { typeId: 8 })).toBe('DATE\'2024-01-15\'');
  });

  test('renders NULL for null values regardless of type', () => {
    expect(getDuckDbLiteralForValue(null, { typeId: 5 })).toBe('NULL');
    expect(getDuckDbLiteralForValue(null, { typeId: 10 })).toBe('NULL');
    expect(getDuckDbLiteralForValue(null, { typeId: 7, scale: 2 })).toBe('NULL');
  });

  test('throws for unsupported arrow types', () => {
    expect(() => getDuckDbLiteralForValue('x', { typeId: 0 })).toThrow('Unrecognized arrow type 0');
  });
});

describe('SQLHelper getArrowDecimalAsString', () => {
  test('converts scaled decimal values to strings', () => {
    expect(getArrowDecimalAsString('123456', { scale: 2 })).toBe('1234.56');
    expect(getArrowDecimalAsString('-123', { scale: 2 })).toBe('-1.23');
  });

  test('handles zero-scale and null values', () => {
    expect(getArrowDecimalAsString('123', { scale: 0 })).toBe('123');
    expect(getArrowDecimalAsString('0', { scale: 0 })).toBe('0');
    expect(getArrowDecimalAsString(null, { scale: 0 })).toBe('NULL');
  });
});

describe('SQLHelper identifier and SQL utility helpers', () => {
  test('quotes and unquotes literals and identifiers', () => {
    expect(quoteStringLiteral('O\'Reilly')).toBe('\'O\'\'Reilly\'');
    expect(isQuoted('"a"', '"')).toBe(true);
    expect(isQuoted('a', '"')).toBe(false);
    expect(unQuote('"a"', '"')).toBe('a');
    expect(() => unQuote('a"', '"')).toThrow('Cannot unquote value: a"');

    expect(getQuotedIdentifier('needs"quote')).toBe('"needs""quote"');
    expect(getIdentifier('select', false)).toBe('"select"');
    expect(identifierRequiresQuoting('hello world')).toBe(true);
    expect(identifierRequiresQuoting('plain_identifier')).toBe(false);
    expect(quoteIdentifierWhenRequired('select')).toBe('"select"');
    expect(quoteIdentifierWhenRequired('"already"')).toBe('"already"');
  });

  test('builds qualified identifiers for argument permutations', () => {
    expect(getQualifiedIdentifier('table')).toBe('table');
    expect(getQualifiedIdentifier('schema', 'table')).toBe('schema.table');
    expect(getQualifiedIdentifier(['schema', 'table'], { alwaysQuoteIdentifiers: true })).toBe('"schema"."table"');
    expect(getQualifiedIdentifier('schema', 'table', 'column')).toBe('schema.table.column');
    expect(getQualifiedIdentifier('schema', 'table', { alwaysQuoteIdentifiers: true })).toBe('"schema"."table"');

    expect(() => getQualifiedIdentifier()).toThrow('Invalid number of arguments.');
    expect(() => getQualifiedIdentifier(123, { alwaysQuoteIdentifiers: false })).toThrow('Invalid argument');
    expect(() => getQualifiedIdentifier('schema', 123)).toThrow('Invalid argument type number');
  });

  test('renders copy clauses, commas and sql options', () => {
    expect(getCopyToStatement('SELECT 1', 'out.csv', { DELIMITER: '\',\'', HEADER: true })).toContain('COPY (');
    expect(getComma('spaceAfter')).toBe(', ');
    expect(getComma('newlineAfter')).toBe(',\n');
    expect(getComma('newlineBefore')).toBe('\n,');

    const options = normalizeSqlOptions({ alwaysQuoteIdentifiers: true });
    expect(options).toMatchObject({ alwaysQuoteIdentifiers: true, commaStyle: 'spaceAfter' });
    expect(getSqlValuesClause(['1', '2'])).toBe('(VALUES (1),(2) )');
    expect(getSqlValuesClause(['1'], 'v', 'c')).toBe('(VALUES (1) ) AS v(c)');
  });
});

describe('SQLHelper type descriptor helpers', () => {
  test('parses struct, map and array types', () => {
    const structType = 'STRUCT(id INTEGER, "display name" VARCHAR, nested STRUCT(flag BOOLEAN))';
    expect(getStructTypeDescriptor(structType)).toEqual({
      id: 'INTEGER',
      'display name': 'VARCHAR',
      nested: 'STRUCT(flag BOOLEAN)',
    });

    const mapType = 'MAP(VARCHAR, INTEGER[])';
    expect(getMapKeyValueType(mapType)).toEqual({ keyType: 'VARCHAR', valueType: 'INTEGER[]' });
    expect(getMapKeyType(mapType)).toBe('VARCHAR');
    expect(getMapValueType(mapType)).toBe('INTEGER[]');
    expect(getMapEntryType(mapType)).toBe('STRUCT(key VARCHAR, value INTEGER[])');
    expect(getMapEntriesType(mapType)).toBe('STRUCT(key VARCHAR, value INTEGER[])[]');

    expect(isArrayType('INTEGER[]')).toBe(true);
    expect(isMapType(mapType)).toBe(true);
    expect(isStructType(structType)).toBe(true);
    expect(getArrayElementType('INTEGER[]')).toBe('INTEGER');
    expect(getArrayType('BOOLEAN')).toBe('BOOLEAN[]');
    expect(isStringType('VARCHAR')).toBe(true);
    expect(isStringType('BLOB')).toBe(true);
    expect(isStringType('INTEGER')).toBe(false);

    expect(() => getMapKeyValueType('VARCHAR')).toThrow('Expected a MAP type');
    expect(() => getArrayElementType('INTEGER')).toThrow('Expected an array type');
  });

  test('resolves member expression output types', () => {
    expect(getMemberExpressionType('INTEGER[]', ['unnest()'])).toBe('INTEGER');
    expect(getMemberExpressionType('INTEGER[]', ['generate_subscripts()'])).toBe('BIGINT');
    expect(getMemberExpressionType('MAP(VARCHAR, BIGINT)', ['map_entries()'])).toBe('STRUCT(key VARCHAR, value BIGINT)[]');
    expect(getMemberExpressionType('MAP(VARCHAR, BIGINT)', ['map_keys()'])).toBe('VARCHAR[]');
    expect(getMemberExpressionType('MAP(VARCHAR, BIGINT)', ['map_values()'])).toBe('BIGINT[]');
    expect(getMemberExpressionType('MAP(VARCHAR, BIGINT)', 'key')).toBe('VARCHAR');
    expect(getMemberExpressionType('MAP(VARCHAR, BIGINT)', 'value')).toBe('BIGINT');
    expect(getMemberExpressionType('STRUCT(a INTEGER, b VARCHAR)', ['b'])).toBe('VARCHAR');
    expect(getMemberExpressionType('INTEGER', [])).toBe('INTEGER');

    expect(() => getMemberExpressionType('INTEGER', 'key')).toThrow('Expected a MAP type');
    expect(() => getMemberExpressionType('MAP(VARCHAR, BIGINT)', 'unknown')).toThrow('Don\'t know how to handle memberExpressionPath "unknown"');
    expect(getMemberExpressionType('INTEGER', 123)).toBe('INTEGER');
  });
});

describe('SQLHelper sampling and aggregate type helpers', () => {
  test('renders sampling clauses', () => {
    expect(getUsingSampleClause({ size: 10, method: 'LIMIT' }, false)).toBe('LIMIT 10');
    expect(getUsingSampleClause({ size: 5, unit: 'ROWS', method: 'SYSTEM', seed: 11 }, true)).toBe('TABLESAMPLE 5 ROWS ( SYSTEM, 11 )');
    expect(getUsingSampleClause({}, false)).toBe('USING SAMPLE 100 ROWS ( SYSTEM )');
  });

  test('handles column expression extrapolation and median return data type', () => {
    expect(extrapolateColumnExpression('sum(${columnExpression})', 'amount')).toBe('sum(amount)');
    expect(getMedianReturnDataTypeForArgumentDataType('INTEGER')).toBe('DOUBLE');
    expect(getMedianReturnDataTypeForArgumentDataType('DOUBLE')).toBe('DOUBLE');
  });
});
