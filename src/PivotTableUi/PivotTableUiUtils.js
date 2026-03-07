/**
 * Pure utility functions extracted from PivotTableUi.
 * These functions have no dependency on PivotTableUi instance state.
 */

/**
 * Default configuration values for PivotTableUi.
 */
export const pivotTableUiDefaults = {
  resizeTimeout: 1000,
  scrollTimeout: 500,
  columnHeaderResizeTimeout: 500,
  maximumCellWidth: 30,
  defaultDittoMark: '〃',
  defaultHideRepeatingAxisValues: true,
  defaultPageSize: 100,
  renderBatchSize: 10,
  templateId: 'pivotTableUiTemplate'
};

export function appendNodes(parentNode, nodes, beforeNode) {
  if (!nodes?.length) {
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < nodes.length; i++) {
    fragment.appendChild(nodes[i]);
  }
  if (beforeNode) {
    parentNode.insertBefore(fragment, beforeNode);
    return;
  }
  parentNode.appendChild(fragment);
}

export function waitForAnimationFrame(requestAnimationFrameImplementation = globalThis.requestAnimationFrame?.bind(globalThis)) {
  if (typeof requestAnimationFrameImplementation !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrameImplementation(() => {
      resolve();
    });
  });
}

/**
 * Get the indices of all totals items in a query axis items array.
 * Items with `includeTotals === true` are collected (in reverse order).
 * @param {Array} queryAxisItems - Array of query axis items
 * @returns {number[]|undefined} Array of indices (most significant first), or undefined if none
 */
export function getTotalsItemsIndices(queryAxisItems) {
  return queryAxisItems && queryAxisItems.length
    ? queryAxisItems.reduce((acc, curr, index) => {
        if (curr.includeTotals) {
          acc.unshift(index);
        }
        return acc;
      }, [])
    : undefined;
}

/**
 * Determine whether a tuple member at a given index is a totals member,
 * based on the grouping ID bitmask and the totals items indices.
 *
 * Returns the index of the totals item whose bit is the most significant set bit
 * in the groupingId, or Infinity if the member is not a totals member.
 *
 * @param {BigInt|undefined} groupingId - The GROUPING_ID() value from DuckDB
 * @param {number[]|undefined} totalsItemsIndices - Indices of items with includeTotals
 * @param {number|undefined} currentItemIndex - The index of the current item
 * @returns {number|Infinity}
 */
export function isTotalsMember(groupingId, totalsItemsIndices, currentItemIndex) {
  if (
    !groupingId ||
    !totalsItemsIndices ||
    !totalsItemsIndices.length ||
    currentItemIndex === undefined
  ) {
    return Infinity;
  }

  let i = BigInt(totalsItemsIndices.length - 1);
  while (i >= 0n && !(groupingId & (1n << i))) {
    i -= 1n;
  }

  return (i < 0n) ? Infinity : totalsItemsIndices[i];
}

/**
 * Extract the ditto mark setting from a settings object.
 * @param {Object} settingsObj - Settings object (may have getSettings method)
 * @returns {string} The ditto mark character
 */
export function getDittoMark(settingsObj) {
  let dittoMark;
  let s = settingsObj;
  if (s && typeof s.getSettings === 'function') {
    s = s.getSettings('pivotSettings');
  }
  if (s) {
    dittoMark = s.dittoMark;
  }
  if (dittoMark === undefined) {
    dittoMark = pivotTableUiDefaults.defaultDittoMark;
  }
  return dittoMark;
}

/**
 * Extract the hideRepeatingAxisValues setting from a settings object.
 * @param {Object} settingsObj - Settings object (may have getSettings method)
 * @returns {boolean} Whether to hide repeating axis values
 */
export function getHideRepeatingAxisValues(settingsObj) {
  let hideRepeatingAxisValues;
  let s = settingsObj;
  if (s && typeof s.getSettings === 'function') {
    s = s.getSettings('pivotSettings');
  }
  if (s) {
    hideRepeatingAxisValues = s.hideRepeatingAxisValues;
  }
  if (hideRepeatingAxisValues === undefined) {
    hideRepeatingAxisValues = pivotTableUiDefaults.defaultHideRepeatingAxisValues;
  }
  return hideRepeatingAxisValues;
}

/**
 * Extract the maxCellWidth setting from a settings object.
 * @param {Object} settingsObj - Settings object (may have getSettings method)
 * @returns {number} The maximum cell width in ch units
 */
export function getMaxCellWidth(settingsObj) {
  let maxCellWidth;
  let s = settingsObj;
  if (s && typeof s.getSettings === 'function') {
    s = s.getSettings('pivotSettings');
  }
  if (s) {
    maxCellWidth = s.maxCellWidth;
  }
  if (maxCellWidth) {
    maxCellWidth = parseInt(maxCellWidth, 10);
  }
  if (maxCellWidth === undefined || isNaN(maxCellWidth) || maxCellWidth <= 0) {
    maxCellWidth = pivotTableUiDefaults.maximumCellWidth;
  }
  return maxCellWidth;
}
