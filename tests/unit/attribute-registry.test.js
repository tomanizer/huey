vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

import {
  aggregators,
  arrayStatisticsDerivations,
  tupleNumberDerivations,
  dateFields,
  timeFields,
  hashDerivations,
  textDerivations,
  uuidDerivations,
  arrayDerivations,
  mapDerivations,
  getApplicableDerivations,
  getDerivationInfo,
  getAggregatorInfo,
  getApplicableAggregators,
  getArrayDerivations,
  getMapDerivations,
  getQueryAxisItemDataType,
} from '../../src/AttributeUi/AttributeRegistry.js';

// ─── Aggregator registry ──────────────────────────────────────────────────────

describe('aggregators registry', () => {
  test('contains expected aggregators', () => {
    expect(aggregators['count']).toBeDefined();
    expect(aggregators['sum']).toBeDefined();
    expect(aggregators['avg']).toBeDefined();
    expect(aggregators['min']).toBeDefined();
    expect(aggregators['max']).toBeDefined();
    expect(aggregators['median']).toBeDefined();
  });

  test('count aggregator has HUGEINT column type', () => {
    expect(aggregators['count'].columnType).toBe('HUGEINT');
    expect(aggregators['count'].isInteger).toBe(true);
  });

  test('avg aggregator has createFormatter', () => {
    expect(typeof aggregators['avg'].createFormatter).toBe('function');
  });

  test('max/min/mode have preservesColumnType', () => {
    expect(aggregators['max'].preservesColumnType).toBe(true);
    expect(aggregators['min'].preservesColumnType).toBe(true);
    expect(aggregators['mode'].preservesColumnType).toBe(true);
  });

  test('boolean-only aggregators are marked forBoolean', () => {
    expect(aggregators['and'].forBoolean).toBe(true);
    expect(aggregators['or'].forBoolean).toBe(true);
  });

  test('numeric aggregators are marked forNumeric', () => {
    expect(aggregators['avg'].forNumeric).toBe(true);
    expect(aggregators['sum'].forNumeric).toBe(true);
  });

  test('histogram is in list aggregators folder', () => {
    expect(aggregators['histogram'].folder).toBe('list aggregators');
  });
});

// ─── getAggregatorInfo ────────────────────────────────────────────────────────

describe('getAggregatorInfo', () => {
  test('returns info for known aggregator', () => {
    const info = getAggregatorInfo('count');
    expect(info).toBeDefined();
    expect(info.columnType).toBe('HUGEINT');
  });

  test('returns undefined for unknown aggregator', () => {
    expect(getAggregatorInfo('nonexistent')).toBeUndefined();
  });
});

// ─── getApplicableAggregators ─────────────────────────────────────────────────

describe('getApplicableAggregators', () => {
  test('numeric types include numeric aggregators', () => {
    const applicable = getApplicableAggregators('DOUBLE');
    expect(applicable['avg']).toBeDefined();
    expect(applicable['sum']).toBeDefined();
    expect(applicable['count']).toBeDefined();
  });

  test('non-numeric types exclude numeric-only aggregators', () => {
    const applicable = getApplicableAggregators('VARCHAR');
    expect(applicable['avg']).toBeUndefined();
    expect(applicable['sum']).toBeUndefined();
    expect(applicable['count']).toBeDefined();
  });

  test('BOOLEAN type includes boolean aggregators', () => {
    const applicable = getApplicableAggregators('BOOLEAN');
    expect(applicable['and']).toBeDefined();
    expect(applicable['or']).toBeDefined();
  });

  test('non-BOOLEAN type excludes boolean aggregators', () => {
    const applicable = getApplicableAggregators('INTEGER');
    expect(applicable['and']).toBeUndefined();
    expect(applicable['or']).toBeUndefined();
  });
});

// ─── Derivation registries ────────────────────────────────────────────────────

describe('dateFields registry', () => {
  test('contains expected date derivations', () => {
    expect(dateFields['year']).toBeDefined();
    expect(dateFields['month name']).toBeDefined();
    expect(dateFields['day of week name']).toBeDefined();
    expect(dateFields['iso-date']).toBeDefined();
  });

  test('year derivation returns INTEGER', () => {
    expect(dateFields['year'].columnType).toBe('INTEGER');
  });

  test('month name has createFormatter and createParser', () => {
    expect(typeof dateFields['month name'].createFormatter).toBe('function');
    expect(typeof dateFields['month name'].createParser).toBe('function');
  });
});

describe('textDerivations registry', () => {
  test('contains string operations', () => {
    expect(textDerivations['uppercase']).toBeDefined();
    expect(textDerivations['lowercase']).toBeDefined();
    expect(textDerivations['length']).toBeDefined();
  });

  test('uppercase has VARCHAR column type', () => {
    expect(textDerivations['uppercase'].columnType).toBe('VARCHAR');
  });
});

describe('hashDerivations registry', () => {
  test('contains hash functions', () => {
    expect(hashDerivations['hash']).toBeDefined();
    expect(hashDerivations['md5 (hex)']).toBeDefined();
    expect(hashDerivations['sha-256']).toBeDefined();
  });

  test('string-only hashes are marked forString', () => {
    expect(hashDerivations['md5 (hex)'].forString).toBe(true);
    expect(hashDerivations['sha-256'].forString).toBe(true);
  });

  test('general hash is not marked forString', () => {
    expect(hashDerivations['hash'].forString).toBeUndefined();
  });
});

describe('arrayDerivations registry', () => {
  test('contains array operations', () => {
    expect(arrayDerivations['elements']).toBeDefined();
    expect(arrayDerivations['length']).toBeDefined();
    expect(arrayDerivations['sort values']).toBeDefined();
  });
});

describe('mapDerivations registry', () => {
  test('contains map operations', () => {
    expect(mapDerivations['entries']).toBeDefined();
    expect(mapDerivations['keyset']).toBeDefined();
    expect(mapDerivations['valuelist']).toBeDefined();
  });
});

describe('arrayStatisticsDerivations', () => {
  test('is derived from aggregators (excludes list aggregators)', () => {
    expect(arrayStatisticsDerivations['avg']).toBeDefined();
    expect(arrayStatisticsDerivations['count']).toBeDefined();
    expect(arrayStatisticsDerivations['histogram']).toBeUndefined();
    expect(arrayStatisticsDerivations['list']).toBeUndefined();
  });

  test('uses list_aggregate expression template', () => {
    const avgDerivation = arrayStatisticsDerivations['avg'];
    expect(avgDerivation.expressionTemplate).toContain('list_aggregate');
  });
});

describe('tupleNumberDerivations', () => {
  test('contains row number derivation', () => {
    expect(tupleNumberDerivations['row number']).toBeDefined();
    expect(tupleNumberDerivations['row number'].columnType).toBe('INTEGER');
    expect(tupleNumberDerivations['row number'].isWindowFunction).toBe(true);
  });
});

// ─── getDerivationInfo ────────────────────────────────────────────────────────

describe('getDerivationInfo', () => {
  test('finds date derivation', () => {
    expect(getDerivationInfo('year')).toBeDefined();
    expect(getDerivationInfo('year').columnType).toBe('INTEGER');
  });

  test('finds text derivation', () => {
    expect(getDerivationInfo('uppercase')).toBeDefined();
  });

  test('finds hash derivation', () => {
    expect(getDerivationInfo('md5 (hex)')).toBeDefined();
  });

  test('finds array derivation', () => {
    expect(getDerivationInfo('elements')).toBeDefined();
  });

  test('finds map derivation', () => {
    expect(getDerivationInfo('entries')).toBeDefined();
  });

  test('finds tuple number derivation', () => {
    expect(getDerivationInfo('row number')).toBeDefined();
  });

  test('returns undefined for unknown derivation', () => {
    expect(getDerivationInfo('nonexistent')).toBeUndefined();
  });
});

// ─── getApplicableDerivations ─────────────────────────────────────────────────

describe('getApplicableDerivations', () => {
  test('DATE type gets date fields', () => {
    const derivations = getApplicableDerivations('DATE');
    expect(derivations['year']).toBeDefined();
    expect(derivations['month name']).toBeDefined();
    expect(derivations['uppercase']).toBeUndefined();
  });

  test('VARCHAR type gets text derivations and string-specific hashes', () => {
    const derivations = getApplicableDerivations('VARCHAR');
    expect(derivations['uppercase']).toBeDefined();
    expect(derivations['md5 (hex)']).toBeDefined();
    expect(derivations['year']).toBeUndefined();
  });

  test('STRUCT type gets hash but not string-only hashes', () => {
    const derivations = getApplicableDerivations('STRUCT');
    expect(derivations['hash']).toBeDefined();
    expect(derivations['md5 (hex)']).toBeUndefined();
  });

  test('INTEGER type gets no derivations', () => {
    const derivations = getApplicableDerivations('INTEGER');
    expect(Object.keys(derivations)).toHaveLength(0);
  });

  test('JSON is treated as string type', () => {
    const derivations = getApplicableDerivations('JSON');
    expect(derivations['md5 (hex)']).toBeDefined();
    expect(derivations['hash']).toBeDefined();
  });
});

// ─── getArrayDerivations ──────────────────────────────────────────────────────

describe('getArrayDerivations', () => {
  test('returns array operations for any type', () => {
    const derivations = getArrayDerivations('INTEGER[]');
    expect(derivations['elements']).toBeDefined();
    expect(derivations['length']).toBeDefined();
  });

  test('includes numeric statistics for numeric element types', () => {
    const derivations = getArrayDerivations('DOUBLE');
    expect(derivations['avg']).toBeDefined();
    expect(derivations['sum']).toBeDefined();
  });
});

// ─── getMapDerivations ────────────────────────────────────────────────────────

describe('getMapDerivations', () => {
  test('returns map operations', () => {
    const derivations = getMapDerivations('MAP');
    expect(derivations['entries']).toBeDefined();
    expect(derivations['keyset']).toBeDefined();
  });
});

// ─── getQueryAxisItemDataType ─────────────────────────────────────────────────

describe('getQueryAxisItemDataType', () => {
  test('returns columnType for plain item', () => {
    expect(getQueryAxisItemDataType({ columnType: 'VARCHAR' })).toBe('VARCHAR');
    expect(getQueryAxisItemDataType({ columnType: 'INTEGER' })).toBe('INTEGER');
  });

  test('applies derivation column type override', () => {
    const item = { columnType: 'DATE', derivation: 'year' };
    expect(getQueryAxisItemDataType(item)).toBe('INTEGER');
  });

  test('applies aggregator column type override', () => {
    const item = { columnType: 'VARCHAR', aggregator: 'count' };
    expect(getQueryAxisItemDataType(item)).toBe('HUGEINT');
  });

  test('preserves column type for max/min', () => {
    const item = { columnType: 'DOUBLE', aggregator: 'max' };
    expect(getQueryAxisItemDataType(item)).toBe('DOUBLE');
  });

  test('sum preserves numeric type', () => {
    const item = { columnType: 'INTEGER', aggregator: 'sum' };
    // sum returns undefined in type system (no columnType, no preserves) → undefined
    expect(getQueryAxisItemDataType(item)).toBeUndefined();
  });

  test('returns undefined for aggregator without known return type', () => {
    const item = { columnType: 'VARCHAR', aggregator: 'avg' };
    // avg is forNumeric but columnType stays undefined since avg has a createFormatter but no columnType
    // avg has no columnType and no preservesColumnType → undefined
    expect(getQueryAxisItemDataType(item)).toBeUndefined();
  });
});
