/**
 * @module QueryModelConstants
 * Axis identifier string constants shared between QueryModel and QueryAxisItem.
 * Extracted to eliminate the circular dependency that previously required
 * the _setQueryModelRef forward-reference pattern.
 */

export const AXIS_FILTERS = 'filters';
export const AXIS_ROWS = 'rows';
export const AXIS_COLUMNS = 'columns';
export const AXIS_CELLS = 'cells';
