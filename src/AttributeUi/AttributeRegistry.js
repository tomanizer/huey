/**
 * @module AttributeRegistry
 * Pure data registry for aggregators, derivations, and related helpers.
 * No DOM dependencies — directly unit-testable.
 *
 * Also exports `getQueryAxisItemDataType`, previously a static method on
 * QueryAxisItem, to break the circular dependency:
 *   QueryAxisItem → AttributeUi → QueryModel → QueryAxisItem
 */

import {
  getDataTypeInfo,
  fallbackFormatter,
  createNumberFormatter,
  createLocalDateFormatter,
  createMonthFullNameFormatter,
  createMonthFullNameParser,
  createMonthShortNameFormatter,
  createMonthShortNameParser,
  createDayFullNameFormatter,
  createDayFullNameParser,
  createDayShortNameFormatter,
  createDayShortNameParser,
  getMedianReturnDataTypeForArgumentDataType,
  getMemberExpressionType,
  getArrayElementType,
  getArrayType,
  getMapEntryType,
  monthNumFormatter,
  weekNumFormatter,
  dayNumFormatter,
  isStringType,
} from '../util/sql/SQLHelper.js';

// ─── Aggregators ──────────────────────────────────────────────────────────────

export const aggregators = {
  'and': {
    forBoolean: true,
    expressionTemplate: 'BOOL_AND( ${columnExpression} )',
    columnType: 'BOOLEAN'
  },
  'avg': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'AVG( ${columnExpression} )',
    createFormatter: function(_axisItem){
      const formatter = createNumberFormatter(true);
      return function(value, field){
        return formatter.format(value, field);
      };
    }
  },
  'count': {
    isNumeric: true,
    isInteger: true,
    expressionTemplate: 'COUNT( ${columnExpression} )',
    columnType: 'HUGEINT'
  },
  'count if false': {
    forBoolean: true,
    expressionTemplate: 'COUNT( ${columnExpression} ) FILTER( NOT( ${columnExpression} ) )',
    columnType: 'HUGEINT'
  },
  'count if true': {
    forBoolean: true,
    expressionTemplate: 'COUNT( ${columnExpression} ) FILTER( ${columnExpression} )',
    columnType: 'HUGEINT'
  },
  'distinct count': {
    isNumeric: true,
    isInteger: true,
    expressionTemplate: 'COUNT( DISTINCT ${columnExpression} )',
    columnType: 'HUGEINT'
  },
  'entropy': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    expressionTemplate: 'ENTROPY( ${columnExpression} )',
    columnType: 'DOUBLE'
  },
  'geomean': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'GEOMEAN( ${columnExpression} )',
    createFormatter: function(_axisItem){
      const formatter = createNumberFormatter(true);
      return function(value, field){
        return formatter.format(value, field);
      };
    }
  },
  'histogram': {
    folder: "list aggregators",
    expressionTemplate: 'HISTOGRAM( ${columnExpression} )',
    isStruct: true,
  },
  'kurtosis': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'KURTOSIS( ${columnExpression} )',
    columnType: 'DOUBLE'
  },
  'list': {
    folder: "list aggregators",
    expressionTemplate: 'LIST( ${columnExpression} )',
    isArray: true
  },
  'unique values': {
    folder: "list aggregators",
    expressionTemplate: 'LIST( DISTINCT ${columnExpression} ORDER BY ${columnExpression} )',
    isArray: true
  },
  'mad': {
    folder: "statistics",
    columnType: 'INTERVAL',
    forNumeric: true,
    expressionTemplate: 'MAD( ${columnExpression} )'
  },
  'max': {
    folder: "statistics",
    preservesColumnType: true,
    expressionTemplate: 'MAX( ${columnExpression} )'
  },
  'median': {
    folder: "statistics",
    expressionTemplate: 'MEDIAN( ${columnExpression} )',
    getReturnDataTypeForArgumentDataType: getMedianReturnDataTypeForArgumentDataType,
    createFormatter: function(axisItem){
      const columnType = getQueryAxisItemDataType(axisItem);
      const dataTypeInfo = getDataTypeInfo(columnType);
      let formatter;
      if (dataTypeInfo.isNumeric) {
        formatter = createNumberFormatter(dataTypeInfo.isInteger !== true);
        return function(value, field){
          return formatter.format(value, field);
        };
      }
      else {
        return function(value, _field){
          return fallbackFormatter(value);
        };
      }
    }
  },
  'min': {
    folder: "statistics",
    preservesColumnType: true,
    expressionTemplate: 'MIN( ${columnExpression} )'
  },
  'mode': {
    folder: "statistics",
    preservesColumnType: true,
    expressionTemplate: 'MODE( ${columnExpression} )'
  },
  'or': {
    forBoolean: true,
    expressionTemplate: 'BOOL_OR( ${columnExpression} )',
    columnType: 'BOOLEAN'
  },
  'skewness': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'SKEWNESS( ${columnExpression} )',
    columnType: 'DOUBLE'
  },
  'stdev': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'STDDEV_SAMP( ${columnExpression} )',
    columnType: 'DOUBLE'
  },
  'sum': {
    isNumeric: true,
    forNumeric: true,
    expressionTemplate: 'SUM( ${columnExpression} )',
    createFormatter: function(axisItem){
      const columnType = axisItem.columnType;
      const dataTypeInfo = getDataTypeInfo(columnType);
      const isInteger = dataTypeInfo.isInteger;
      const formatter = createNumberFormatter(isInteger !== true);
      return function(value, field){
        return formatter.format(value, field);
      };
    }
  },
  'variance': {
    folder: "statistics",
    isNumeric: true,
    isInteger: false,
    forNumeric: true,
    expressionTemplate: 'VAR_SAMP( ${columnExpression} )',
    columnType: 'DOUBLE'
  }
};

export const arrayStatisticsDerivations = Object
  .keys(aggregators)
  .filter((aggregator) => {
    const aggregatorInfo = aggregators[aggregator];
    return aggregatorInfo.folder !== 'list aggregators';
  })
  .reduce((arrayStatisticsDerivations, aggregator) => {
    const aggregatorInfo = aggregators[aggregator];
    const aggregateFunction = aggregatorInfo.expressionTemplate.split('(')[0];
    const derivationInfo = Object.assign({}, aggregatorInfo);
    if (derivationInfo.preservesColumnType){
      derivationInfo.hasElementDataType = true;
      delete derivationInfo.preservesColumnType;
    }
    derivationInfo.folder = `array statistics`;
    let expressionTemplate;
    switch (aggregator) {
      case 'distinct count':
        expressionTemplate = 'list_unique( ${columnExpression} )';
        break;
      default:
        expressionTemplate = `list_aggregate( \${columnExpression}, '${aggregateFunction}' )`;
    }
    derivationInfo.expressionTemplate = expressionTemplate;
    arrayStatisticsDerivations[aggregator] = derivationInfo;
    return arrayStatisticsDerivations;
  }, {});

// ─── Derivations ──────────────────────────────────────────────────────────────

export const tupleNumberDerivations = {
  "row number": {
    expressionTemplate: "ROW_NUMBER() OVER ()::INTEGER",
    columnType: 'INTEGER',
    isWindowFunction: true
  }
};

export const dateFields = {
  'iso-date': {
    expressionTemplate: "strftime( ${columnExpression}, '%x' )",
    columnType: 'VARCHAR'
  },
  'local-date': {
    expressionTemplate: "${columnExpression}::DATE",
    columnType: 'DATE',
    createFormatter: createLocalDateFormatter
  },
  'year': {
    folder: 'date fields',
    expressionTemplate: "CAST( YEAR( ${columnExpression} ) AS INT)",
    columnType: 'INTEGER',
    createFormatter: function(){
      return fallbackFormatter;
    }
  },
  'iso-year': {
    folder: 'date fields',
    expressionTemplate: "CAST( ISOYEAR( ${columnExpression} ) AS INT)",
    columnType: 'INTEGER',
    createFormatter: function(){
      return fallbackFormatter;
    }
  },
  'quarter': {
    folder: 'date fields',
    expressionTemplate: "'Q' || QUARTER( ${columnExpression} )",
    columnType: 'VARCHAR'
  },
  'month num': {
    folder: 'date fields',
    expressionTemplate: "CAST( MONTH( ${columnExpression} ) AS UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: function(){
      return monthNumFormatter;
    }
  },
  'month name': {
    folder: 'date fields',
    expressionTemplate: "CAST( MONTH( ${columnExpression} ) AS UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: createMonthFullNameFormatter,
    createParser: createMonthFullNameParser,
    dataValueTypeOverride: 'Utf8'
  },
  'month shortname': {
    folder: 'date fields',
    expressionTemplate: "CAST( MONTH( ${columnExpression} ) AS UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: createMonthShortNameFormatter,
    createParser: createMonthShortNameParser,
    dataValueTypeOverride: 'Utf8'
  },
  'week num': {
    folder: 'date fields',
    expressionTemplate: "CAST( WEEK( ${columnExpression} ) AS UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: function(){
      return weekNumFormatter;
    },
  },
  'day of year': {
    folder: 'date fields',
    expressionTemplate: "CAST( DAYOFYEAR( ${columnExpression} ) as USMALLINT)",
    columnType: 'USMALLINT'
  },
  'day of month': {
    folder: 'date fields',
    expressionTemplate: "CAST( DAYOFMONTH( ${columnExpression} ) AS UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: function(){
      return dayNumFormatter;
    },
  },
  'day of week num': {
    folder: 'date fields',
    expressionTemplate: "CAST( DAYOFWEEK( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT',
  },
  'iso-day of week': {
    folder: 'date fields',
    expressionTemplate: "CAST( ISODOW( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT',
  },
  'day of week name': {
    folder: 'date fields',
    expressionTemplate: "CAST( DAYOFWEEK( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: createDayFullNameFormatter,
    createParser: createDayFullNameParser,
    dataValueTypeOverride: 'Utf8'
  },
  'day of week shortname': {
    folder: 'date fields',
    expressionTemplate: "CAST( DAYOFWEEK( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT',
    createFormatter: createDayShortNameFormatter,
    createParser: createDayShortNameParser,
    dataValueTypeOverride: 'Utf8'
  },
  'timestamp (secs)': {
    folder: 'timestamps',
    expressionTemplate: 'epoch( ${columnExpression} )',
    columnType: 'DOUBLE'
  },
  'timestamp (millis)': {
    folder: 'timestamps',
    expressionTemplate: 'epoch_ms( ${columnExpression} )',
    columnType: 'BIGINT'
  },
  'timestamp (micros)': {
    folder: 'timestamps',
    expressionTemplate: 'epoch_us( ${columnExpression} )',
    columnType: 'BIGINT'
  },
  'timestamp (nanos)': {
    folder: 'timestamps',
    expressionTemplate: 'epoch_ns( ${columnExpression} )',
    columnType: 'BIGINT'
  }
};

export const timeFields = {
  'iso-time': {
    folder: 'time fields',
    expressionTemplate: "strftime( ${columnExpression}, '%H:%M:%S' )",
    columnType: 'VARCHAR'
  },
  'hour': {
    folder: 'time fields',
    expressionTemplate: "CAST( HOUR( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT',
    formats: { 'short': {}, 'long': {} }
  },
  'minute': {
    folder: 'time fields',
    expressionTemplate: "CAST( MINUTE( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT'
  },
  'second': {
    folder: 'time fields',
    expressionTemplate: "CAST( SECOND( ${columnExpression} ) as UTINYINT)",
    columnType: 'UTINYINT'
  }
};

export const hashDerivations = {
  "hash": {
    folder: 'hashes',
    expressionTemplate: 'hash( ${columnExpression} )',
    columnType: 'UBIGINT'
  },
  "md5 (hex)": {
    folder: 'hashes',
    expressionTemplate: 'md5( ${columnExpression} )',
    columnType: 'VARCHAR',
    forString: true
  },
  "md5": {
    folder: 'hashes',
    expressionTemplate: 'md5_number( ${columnExpression} )',
    columnType: 'HUGEINT',
    forString: true
  },
  "md5 low": {
    folder: 'hashes',
    expressionTemplate: 'md5_number_lower( ${columnExpression} )',
    columnType: 'UBIGINT',
    forString: true
  },
  "md5 high": {
    folder: 'hashes',
    expressionTemplate: 'md5_number_upper( ${columnExpression} )',
    columnType: 'UBIGINT',
    forString: true
  },
  "sha-1": {
    folder: 'hashes',
    expressionTemplate: 'sha1( ${columnExpression} )',
    columnType: 'VARCHAR',
    forString: true
  },
  "sha-256": {
    folder: 'hashes',
    expressionTemplate: 'sha256( ${columnExpression} )',
    columnType: 'VARCHAR',
    forString: true
  }
};

export const textDerivations = {
  "first letter": {
    folder: 'string operations',
    expressionTemplate: "upper( ${columnExpression}[1] )",
    columnType: 'VARCHAR'
  },
  "length": {
    folder: 'string operations',
    expressionTemplate: "length( ${columnExpression} )",
    columnType: 'BIGINT'
  },
  'lowercase': {
    folder: 'string operations',
    expressionTemplate: "LOWER( ${columnExpression} )",
    columnType: 'VARCHAR'
  },
  'NOACCENT': {
    folder: 'string operations',
    expressionTemplate: "${columnExpression} COLLATE NOACCENT",
    columnType: 'VARCHAR'
  },
  'NOCASE': {
    folder: 'string operations',
    expressionTemplate: "${columnExpression} COLLATE NOCASE",
    columnType: 'VARCHAR'
  },
  'uppercase': {
    folder: 'string operations',
    expressionTemplate: "UPPER( ${columnExpression} )",
    columnType: 'VARCHAR'
  }
};

/* https://github.com/rpbouman/huey/issues/612 */
export const uuidDerivations = {
  "UUID version": {
    folder: 'UUID',
    expressionTemplate: "uuid_extract_version( ${columnExpression} )",
    columnType: 'INTEGER'
  },
  "UUIDv7 timestamp": {
    folder: 'UUID',
    expressionTemplate: "CASE uuid_extract_version( ${columnExpression} ) WHEN 7 THEN uuid_extract_timestamp( ${columnExpression} ) END",
    columnType: 'TIMESTAMP WITH TIME ZONE'
  },
};

export const arrayDerivations = {
  "elements": {
    folder: 'array operations',
    hasElementDataType: true,
    expressionTemplate: "unnest( case len( coalesce( ${columnExpression}, []) ) when 0 then [ NULL ] else ${columnExpression} end )",
    unnestingFunction: 'unnest'
  },
  "element indices": {
    folder: 'array operations',
    columnType: 'BIGINT',
    expressionTemplate: "generate_subscripts( case len( coalesce( ${columnExpression}, []) ) when 0 then [ NULL ] else ${columnExpression} end, 1)",
    unnestingFunction: 'generate_subscripts'
  },
  "length": {
    folder: 'array operations',
    expressionTemplate: "length( ${columnExpression} )",
    columnType: 'BIGINT'
  },
  "sort values": {
    folder: 'array operations',
    expressionTemplate: "list_sort( ${columnExpression} )",
    preservesColumnType: true
  },
  "unique values":{
    folder: 'array operations',
    expressionTemplate: "list_sort( list_distinct( ${columnExpression} ) )",
    preservesColumnType: true
  },
  "unique values length":{
    folder: 'array operations',
    expressionTemplate: "length( list_distinct( ${columnExpression} ) )",
    columnType: 'BIGINT'
  }
};

export const mapDerivations = {
  "entries": {
    folder: 'map operations',
    expressionTemplate: "unnest( map_entries( ${columnExpression} ) )",
    unnestingFunction: 'unnest',
    hasEntryArrayDataType: true
  },
  "entry count": {
    folder: 'map operations',
    expressionTemplate: "cardinality( ${columnExpression} )",
    columnType: 'BIGINT'
  },
  "keyset": {
    folder: 'map operations',
    expressionTemplate: "list_sort( map_keys( ${columnExpression} ) )",
    hasKeyArrayDataType: true
  },
  "valuelist": {
    folder: 'map operations',
    expressionTemplate: "list_sort( map_values( ${columnExpression} ) )",
    hasValueArrayDataType: true
  }
};

// ─── Registry lookup helpers ───────────────────────────────────────────────────

/**
 * @param {string} typeName
 * @returns {Object} Map of applicable derivation name → derivation info.
 */
export function getApplicableDerivations(typeName) {
  const typeInfo = getDataTypeInfo(typeName);
  const hasTimeFields = Boolean(typeInfo.hasTimeFields);
  const hasDateFields = Boolean(typeInfo.hasDateFields);
  const hasTextDerivations = Boolean(typeInfo.hasTextDerivations);
  const hasUUIDDerivations = Boolean(typeInfo.hasUUIDDerivations);

  const localHashDerivations = Object.assign({}, hashDerivations);
  const arrayType = typeName === 'ARRAY';
  const mapType = typeName === 'MAP';
  const structType = typeName === 'STRUCT';
  const stringType = isStringType(typeName) || typeName === 'JSON';
  let objectType;
  if (!stringType) {
    objectType = arrayType || mapType || structType;
  }

  if (objectType) {
    Object.keys(localHashDerivations).forEach((hashDerivationKey) => {
      const hashDerivation = localHashDerivations[hashDerivationKey];
      if (hashDerivation.forString) {
        delete localHashDerivations[hashDerivationKey];
      }
    });
  }

  const needHashDerivations = stringType || objectType;
  return Object.assign({},
    hasDateFields ? dateFields : undefined,
    hasTimeFields ? timeFields : undefined,
    hasTextDerivations ? textDerivations : undefined,
    hasUUIDDerivations ? uuidDerivations : undefined,
    needHashDerivations ? localHashDerivations : undefined
  );
}

/**
 * @param {string} derivationName
 * @returns {Object|undefined}
 */
export function getDerivationInfo(derivationName) {
  const derivations = Object.assign({},
    tupleNumberDerivations,
    dateFields,
    timeFields,
    textDerivations,
    hashDerivations,
    uuidDerivations,
    arrayDerivations,
    arrayStatisticsDerivations,
    mapDerivations
  );
  return derivations[derivationName];
}

/**
 * @param {string} aggregatorName
 * @returns {Object|undefined}
 */
export function getAggregatorInfo(aggregatorName) {
  return aggregators[aggregatorName];
}

/**
 * @param {string} typeName
 * @returns {Object} Map of applicable aggregator name → aggregator info.
 */
export function getApplicableAggregators(typeName) {
  const typeInfo = getDataTypeInfo(typeName);
  const isNumeric = Boolean(typeInfo.isNumeric);
  const applicableAggregators = {};
  for (const aggregationName in aggregators) {
    const aggregator = aggregators[aggregationName];
    if (aggregator.forNumeric && !isNumeric) {
      continue;
    }
    if (aggregator.forBoolean && typeName !== 'BOOLEAN') {
      continue;
    }
    applicableAggregators[aggregationName] = aggregator;
  }
  return applicableAggregators;
}

/**
 * @param {string} typeName
 * @returns {Object}
 */
export function getArrayDerivations(typeName) {
  const localArrayDerivations = Object.assign({}, arrayDerivations);
  const applicableAggregators = getApplicableAggregators(typeName);
  Object.keys(applicableAggregators).forEach((aggregator) => {
    const arrayStatisticsDerivation = arrayStatisticsDerivations[aggregator];
    if (!arrayStatisticsDerivation) {
      return;
    }
    localArrayDerivations[aggregator] = arrayStatisticsDerivations[aggregator];
  });
  return localArrayDerivations;
}

/**
 * @param {string} _typeName
 * @returns {Object}
 */
export function getMapDerivations(_typeName) {
  return Object.assign({}, mapDerivations);
}

// ─── getQueryAxisItemDataType (moved from QueryAxisItem to break circular dep) ─

/**
 * Resolves the effective SQL data type of a query axis item, accounting for
 * member expression paths, derivations, and aggregators.
 *
 * @param {import('../QueryModel/QueryAxisItem.js').QueryAxisItem} queryAxisItem
 * @returns {string|undefined}
 */
export function getQueryAxisItemDataType(queryAxisItem) {
  const columnType = queryAxisItem.columnType;
  let dataType = columnType;

  if (queryAxisItem.memberExpressionPath) {
    const memberExpressionPath = queryAxisItem.memberExpressionPath;
    dataType = getMemberExpressionType(columnType, memberExpressionPath);
    if (memberExpressionPath[memberExpressionPath.length - 1].endsWith('()')) {
      return dataType;
    }
  }

  const derivation = queryAxisItem.derivation;
  if (derivation) {
    const derivationInfo = getDerivationInfo(derivation);
    if (derivationInfo.columnType) {
      dataType = derivationInfo.columnType;
    }
    else if (derivationInfo.hasElementDataType) {
      dataType = getArrayElementType(dataType);
    }
    else if (derivationInfo.hasKeyDataType || derivationInfo.hasKeyArrayDataType) {
      dataType = getMemberExpressionType(dataType, 'key');
      if (derivationInfo.hasKeyArrayDataType) {
        dataType = getArrayType(dataType);
      }
    }
    else if (derivationInfo.hasValueDataType || derivationInfo.hasValueArrayDataType) {
      dataType = getArrayElementType(dataType);
      dataType = getMemberExpressionType(dataType, 'value');
      if (derivationInfo.hasValueArrayDataType) {
        dataType = getArrayType(dataType);
      }
    }
    else if (derivationInfo.hasEntryDataType || derivationInfo.hasEntryArrayDataType) {
      dataType = getMapEntryType(dataType);
      if (derivationInfo.hasEntryArrayDataType) {
        dataType = getArrayType(dataType);
      }
    }
    else if (derivation === 'median') {
      dataType = getArrayElementType(dataType);
      dataType = getMedianReturnDataTypeForArgumentDataType(dataType);
    }
    else if (!derivationInfo.preservesColumnType) {
      console.warn(`Item with derivation "${derivation}" does not preserve column type and no column type is set.`);
    }
  }

  const aggregator = queryAxisItem.aggregator;
  if (aggregator) {
    const aggregatorInfo = getAggregatorInfo(aggregator);
    if (aggregatorInfo.columnType) {
      dataType = aggregatorInfo.columnType;
    }
    else if (aggregatorInfo.preservesColumnType) {
      // noop
    }
    else if (typeof aggregatorInfo.getReturnDataTypeForArgumentDataType === 'function') {
      dataType = aggregatorInfo.getReturnDataTypeForArgumentDataType(dataType);
    }
    else {
      dataType = undefined;
    }
  }

  return dataType;
}
