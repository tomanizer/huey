export class RemoteQueryAdapter {
  static #FILTER_OPERATOR_BY_TYPE = {
    in: 'INCLUDE',
    notin: 'EXCLUDE',
    like: 'LIKE',
    between: 'BETWEEN'
  };

  static #AGGREGATION_BY_NAME = {
    sum: 'SUM',
    count: 'COUNT',
    avg: 'AVG',
    min: 'MIN',
    max: 'MAX'
  };

  /** Default date when query model has no date range; use a date that matches common sample data. */
  static #createDefaultDateRange() {
    return { type: 'single', date: '2026-03-01' };
  }

  static getDateRange(queryModel) {
    if (queryModel && typeof queryModel.getDateRange === 'function') {
      var queryModelDateRange = queryModel.getDateRange();
      if (queryModelDateRange && typeof queryModelDateRange === 'object' && queryModelDateRange.type) {
        return queryModelDateRange;
      }
    }
    return RemoteQueryAdapter.#createDefaultDateRange();
  }

  static #getRemoteFieldForAxisItem(axisItem, context) {
    if (!axisItem || typeof axisItem.columnName !== 'string' || !axisItem.columnName.length) {
      throw new Error('Remote datasource requires a valid columnName for ' + context + '.');
    }
    if (axisItem.derivation) {
      throw new Error('Remote datasource does not support derivation "' + axisItem.derivation + '" in ' + context + '.');
    }
    return axisItem.columnName;
  }

  static #normalizeLiteralToValue(literal) {
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

  static #extractFilterEntryValue(entry, key) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return entry.value;
    }
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'literal')) {
      return RemoteQueryAdapter.#normalizeLiteralToValue(entry.literal);
    }
    return key;
  }

  static #getEnabledFilterEntries(values) {
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

  static #getRemoteOperator(filterType, field) {
    var normalizedFilterType = String(filterType || '').toLowerCase();
    var operator = RemoteQueryAdapter.#FILTER_OPERATOR_BY_TYPE[normalizedFilterType];
    if (!operator) {
      throw new Error('Remote datasource does not support filter type "' + normalizedFilterType + '" for field "' + field + '".');
    }
    return operator;
  }

  static #toRemoteFilter(filterAxisItem, context) {
    if (!filterAxisItem || !filterAxisItem.filter) {
      return null;
    }
    var field = RemoteQueryAdapter.#getRemoteFieldForAxisItem(filterAxisItem, context + ' filters');
    var filter = filterAxisItem.filter;
    var operator = RemoteQueryAdapter.#getRemoteOperator(filter.filterType, field);
    var valuesEntries = RemoteQueryAdapter.#getEnabledFilterEntries(filter.values);

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
        RemoteQueryAdapter.#extractFilterEntryValue(rangeStart.entry, rangeStart.key),
        RemoteQueryAdapter.#extractFilterEntryValue(rangeEnd, rangeStart.key)
      ];
    }
    else if (operator === 'LIKE') {
      if (valuesEntries.length !== 1) {
        throw new Error('Remote datasource supports exactly one LIKE pattern per field. Field: "' + field + '".');
      }
      var likeEntry = valuesEntries[0];
      values = [RemoteQueryAdapter.#extractFilterEntryValue(likeEntry.entry, likeEntry.key)];
    }
    else {
      values = valuesEntries.map(function (item) {
        return RemoteQueryAdapter.#extractFilterEntryValue(item.entry, item.key);
      });
    }

    return {
      field: field,
      operator: operator,
      values: values
    };
  }

  static toRemoteFilters(filterAxisItems, context) {
    return (filterAxisItems || [])
      .filter(function (item) {
        return item && item.filter;
      })
      .map(function (item) {
        return RemoteQueryAdapter.#toRemoteFilter(item, context || 'query');
      })
      .filter(function (item) {
        return item !== null;
      });
  }

  static #getRemoteAggregation(axisItem) {
    var aggregationName = String(axisItem.aggregator || 'sum').toLowerCase();
    var aggregation = RemoteQueryAdapter.#AGGREGATION_BY_NAME[aggregationName];
    if (!aggregation) {
      throw new Error('Remote datasource does not support aggregator "' + aggregationName + '" for field "' + axisItem.columnName + '".');
    }
    return aggregation;
  }

  static #getMeasureAlias(axisItem, index) {
    var aggregationName = String(axisItem.aggregator || 'sum').toLowerCase();
    var alias = aggregationName + '_' + axisItem.columnName;
    if (index !== undefined) {
      alias += '_' + index;
    }
    return alias.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  static createRemoteTuplesQuery(queryModel, axisId, limit, offset) {
    var queryAxis = queryModel.getQueryAxis(axisId);
    var axisItems = queryAxis.getItems();
    if (!axisItems.length) {
      return null;
    }

    var fields = axisItems.map(function (item) {
      return {
        field: RemoteQueryAdapter.#getRemoteFieldForAxisItem(item, 'tuples'),
        sort: 'ASC',
        include_totals: item.includeTotals !== false
      };
    });

    var filters = RemoteQueryAdapter.toRemoteFilters(queryModel.getFiltersAxis().getItems(), 'tuples');

    return {
      axis: axisId,
      fields: fields,
      filters: filters,
      paging: { limit: limit, offset: offset }
    };
  }

  static createRemoteCellsQuery(queryModel, rowCount, colCount, cellsAxisItemsToFetch) {
    var rowsAxisItems = queryModel.getRowsAxis().getItems();
    var columnsAxisItems = queryModel.getColumnsAxis().getItems();
    var filters = RemoteQueryAdapter.toRemoteFilters(queryModel.getFiltersAxis().getItems(), 'cells');

    return {
      rows: { start_index: 0, count: Math.max(1, rowCount || 0) },
      columns: { start_index: 0, count: Math.max(1, colCount || 0) },
      axes: {
        rows: rowsAxisItems.map(function (item) {
          return { field: RemoteQueryAdapter.#getRemoteFieldForAxisItem(item, 'cells rows') };
        }),
        columns: columnsAxisItems.map(function (item) {
          return { field: RemoteQueryAdapter.#getRemoteFieldForAxisItem(item, 'cells columns') };
        }),
        measures: (cellsAxisItemsToFetch || []).map(function (item, index) {
          var field = RemoteQueryAdapter.#getRemoteFieldForAxisItem(item, 'cells measures');
          return {
            field: field,
            aggregation: RemoteQueryAdapter.#getRemoteAggregation(item),
            alias: RemoteQueryAdapter.#getMeasureAlias(item, index)
          };
        })
      },
      filters: filters
    };
  }

  static createRemotePicklistQuery(queryAxisItem, filterAxisItems, search, limit, offset) {
    return {
      field: RemoteQueryAdapter.#getRemoteFieldForAxisItem(queryAxisItem, 'picklist'),
      search: search || undefined,
      filters: RemoteQueryAdapter.toRemoteFilters(filterAxisItems, 'picklist'),
      paging: { limit: limit, offset: offset }
    };
  }
}

window.RemoteQueryAdapter = RemoteQueryAdapter;
