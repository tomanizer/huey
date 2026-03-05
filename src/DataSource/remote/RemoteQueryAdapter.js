export const RemoteQueryAdapter = (function () {
  var FILTER_OPERATOR_BY_TYPE = {
    in: 'INCLUDE',
    notin: 'EXCLUDE',
    like: 'LIKE',
    between: 'BETWEEN'
  };

  var AGGREGATION_BY_NAME = {
    sum: 'SUM',
    count: 'COUNT',
    avg: 'AVG',
    min: 'MIN',
    max: 'MAX'
  };

  /** Default date when query model has no date range; use a date that matches common sample data. */
  function createDefaultDateRange() {
    return { type: 'single', date: '2026-03-01' };
  }

  function getDateRange(queryModel) {
    if (queryModel && typeof queryModel.getDateRange === 'function') {
      var queryModelDateRange = queryModel.getDateRange();
      if (queryModelDateRange && typeof queryModelDateRange === 'object' && queryModelDateRange.type) {
        return queryModelDateRange;
      }
    }
    return createDefaultDateRange();
  }

  function getRemoteFieldForAxisItem(axisItem, context) {
    if (!axisItem || typeof axisItem.columnName !== 'string' || !axisItem.columnName.length) {
      throw new Error('Remote datasource requires a valid columnName for ' + context + '.');
    }
    if (axisItem.derivation) {
      throw new Error('Remote datasource does not support derivation "' + axisItem.derivation + '" in ' + context + '.');
    }
    return axisItem.columnName;
  }

  function normalizeLiteralToValue(literal) {
    if (literal === null || literal === undefined) {
      return literal;
    }
    if (literal === 'NULL') {
      return null;
    }
    if (typeof literal !== 'string') {
      return literal;
    }
    if (literal.length >= 2 && literal[0] === '\'' && literal[literal.length - 1] === '\'') {
      return literal.slice(1, -1).replace(/''/g, '\'');
    }
    return literal;
  }

  function extractFilterEntryValue(entry, key) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return entry.value;
    }
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'literal')) {
      return normalizeLiteralToValue(entry.literal);
    }
    return key;
  }

  function getEnabledFilterEntries(values) {
    if (!values || typeof values !== 'object' || values instanceof Array) {
      return [];
    }
    return Object.keys(values)
      .map(function (key) {
        return { key: key, entry: values[key] };
      })
      .filter(function (item) {
        return item.entry && item.entry.enabled !== false;
      });
  }

  function getRemoteOperator(filterType, field) {
    var normalizedFilterType = String(filterType || '').toLowerCase();
    var operator = FILTER_OPERATOR_BY_TYPE[normalizedFilterType];
    if (!operator) {
      throw new Error('Remote datasource does not support filter type "' + normalizedFilterType + '" for field "' + field + '".');
    }
    return operator;
  }

  function toRemoteFilter(filterAxisItem, context) {
    if (!filterAxisItem || !filterAxisItem.filter) {
      return null;
    }
    var field = getRemoteFieldForAxisItem(filterAxisItem, context + ' filters');
    var filter = filterAxisItem.filter;
    var operator = getRemoteOperator(filter.filterType, field);
    var valuesEntries = getEnabledFilterEntries(filter.values);

    if (!valuesEntries.length) {
      return null;
    }

    var values;
    if (operator === 'BETWEEN') {
      if (valuesEntries.length !== 1) {
        throw new Error('Remote datasource supports exactly one BETWEEN range per field. Field: "' + field + '".');
      }
      var rangeStart = valuesEntries[0];
      var toValues = filter.toValues || {};
      var rangeEnd = toValues[rangeStart.key];
      if (!rangeEnd || rangeEnd.enabled === false) {
        throw new Error('Remote datasource requires a matching range end value for BETWEEN filter. Field: "' + field + '".');
      }
      values = [
        extractFilterEntryValue(rangeStart.entry, rangeStart.key),
        extractFilterEntryValue(rangeEnd, rangeStart.key)
      ];
    }
    else if (operator === 'LIKE') {
      if (valuesEntries.length !== 1) {
        throw new Error('Remote datasource supports exactly one LIKE pattern per field. Field: "' + field + '".');
      }
      var likeEntry = valuesEntries[0];
      values = [extractFilterEntryValue(likeEntry.entry, likeEntry.key)];
    }
    else {
      values = valuesEntries.map(function (item) {
        return extractFilterEntryValue(item.entry, item.key);
      });
    }

    return {
      field: field,
      operator: operator,
      values: values
    };
  }

  function toRemoteFilters(filterAxisItems, context) {
    return (filterAxisItems || [])
      .filter(function (item) {
        return item && item.filter;
      })
      .map(function (item) {
        return toRemoteFilter(item, context || 'query');
      })
      .filter(function (item) {
        return item !== null;
      });
  }

  function getRemoteAggregation(axisItem) {
    var aggregationName = String(axisItem.aggregator || 'sum').toLowerCase();
    var aggregation = AGGREGATION_BY_NAME[aggregationName];
    if (!aggregation) {
      throw new Error('Remote datasource does not support aggregator "' + aggregationName + '" for field "' + axisItem.columnName + '".');
    }
    return aggregation;
  }

  function getMeasureAlias(axisItem, index) {
    var aggregationName = String(axisItem.aggregator || 'sum').toLowerCase();
    var alias = aggregationName + '_' + axisItem.columnName;
    if (index !== undefined) {
      alias += '_' + index;
    }
    return alias.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function createRemoteTuplesQuery(queryModel, axisId, limit, offset) {
    var queryAxis = queryModel.getQueryAxis(axisId);
    var axisItems = queryAxis.getItems();
    if (!axisItems.length) {
      return null;
    }

    var fields = axisItems.map(function (item) {
      return {
        field: getRemoteFieldForAxisItem(item, 'tuples'),
        sort: 'ASC',
        include_totals: item.includeTotals !== false
      };
    });

    var filters = toRemoteFilters(queryModel.getFiltersAxis().getItems(), 'tuples');

    return {
      axis: axisId,
      fields: fields,
      filters: filters,
      paging: { limit: limit, offset: offset }
    };
  }

  function createRemoteCellsQuery(queryModel, rowCount, colCount, cellsAxisItemsToFetch) {
    var rowsAxisItems = queryModel.getRowsAxis().getItems();
    var columnsAxisItems = queryModel.getColumnsAxis().getItems();
    var filters = toRemoteFilters(queryModel.getFiltersAxis().getItems(), 'cells');

    return {
      rows: { start_index: 0, count: Math.max(1, rowCount || 0) },
      columns: { start_index: 0, count: Math.max(1, colCount || 0) },
      axes: {
        rows: rowsAxisItems.map(function (item) {
          return { field: getRemoteFieldForAxisItem(item, 'cells rows') };
        }),
        columns: columnsAxisItems.map(function (item) {
          return { field: getRemoteFieldForAxisItem(item, 'cells columns') };
        }),
        measures: (cellsAxisItemsToFetch || []).map(function (item, index) {
          var field = getRemoteFieldForAxisItem(item, 'cells measures');
          return {
            field: field,
            aggregation: getRemoteAggregation(item),
            alias: getMeasureAlias(item, index)
          };
        })
      },
      filters: filters
    };
  }

  function createRemotePicklistQuery(queryAxisItem, filterAxisItems, search, limit, offset) {
    return {
      field: getRemoteFieldForAxisItem(queryAxisItem, 'picklist'),
      search: search || undefined,
      filters: toRemoteFilters(filterAxisItems, 'picklist'),
      paging: { limit: limit, offset: offset }
    };
  }

  const adapter = {
    getDateRange: getDateRange,
    toRemoteFilters: toRemoteFilters,
    createRemoteTuplesQuery: createRemoteTuplesQuery,
    createRemoteCellsQuery: createRemoteCellsQuery,
    createRemotePicklistQuery: createRemotePicklistQuery
  };
  window.RemoteQueryAdapter = adapter;
  return adapter;
})();
