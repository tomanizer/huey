/**
 * @module QuerySerializer
 * Pure serialization helpers for QueryModel state.
 * These functions receive already-resolved data through public QueryModel APIs,
 * so they have no DOM or settings dependencies and are directly unit-testable.
 */

import { AXIS_FILTERS } from './QueryModelConstants.js';

/**
 * Serialize a QueryModel instance to a plain-object snapshot.
 *
 * @param {import('./QueryModel.js').QueryModel} queryModel
 * @param {{includeItemIndices?: boolean}} [options]
 * @returns {Object|null} Plain state object, or null if no datasource / no items.
 */
export function serializeQueryModel(queryModel, options) {
  const datasource = queryModel.getDatasource();
  if (!datasource) {
    return null;
  }
  const datasourceId = datasource.getId();

  const queryModelObject = {
    datasourceId,
    cellsHeaders: queryModel.getCellHeadersAxis(),
    axes: {},
    sampling: queryModel.getSampling(),
  };

  const axisIds = queryModel.getAxisIds().sort();
  let hasItems = false;
  axisIds.forEach((axisId) => {
    const axis = queryModel.getQueryAxis(axisId);
    const items = axis.getItems();
    if (items.length === 0) {
      return;
    }
    hasItems = true;
    queryModelObject.axes[axisId] = items.map((axisItem) => {
      const strippedItem = { columnName: axisItem.columnName };
      strippedItem.columnType = axisItem.columnType;
      if (axisItem.memberExpressionPath) {
        strippedItem.memberExpressionPath = axisItem.memberExpressionPath;
      }
      if (axisItem.derivation) {
        strippedItem.derivation = axisItem.derivation;
      }
      if (axisItem.aggregator) {
        strippedItem.aggregator = axisItem.aggregator;
      }
      if (axisItem.includeTotals === true) {
        strippedItem.includeTotals = true;
      }
      if (axisId === AXIS_FILTERS && axisItem.filter) {
        strippedItem.filter = axisItem.filter;
      }
      if (options && options.includeItemIndices) {
        strippedItem.index = axisItem.index;
      }
      return strippedItem;
    });
  });

  if (!hasItems) {
    return null;
  }
  return queryModelObject;
}
