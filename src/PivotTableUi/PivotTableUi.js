/**
 * @module PivotTableUi
 * Renders a pivot table from a QueryModel and manages user interaction.
 *
 * Lifecycle phases:
 *   1. init          — constructor, #initSettings, #initResizeObserver, #initScrollListener
 *   2. query change  — #handleQueryModelChange → updatePivotTableUi → #loadAndRender
 *   3. render        — #renderHeader, #renderRows, #renderCells, #removeExcess*
 *   4. scroll        — #handleInnerContainerScrolled → #loadAndRender (partial update)
 *   5. resize        — #handleDomResized → updatePivotTableUi (full re-render after debounce)
 *                      #handleColumnHeaderResized → column width bookkeeping
 *   6. context menu  — #initContextMenu, event delegation on right-click
 *
 * Data flow:  QueryModel → TupleSet/CellSet → DOM
 */

import { EventEmitter } from '../util/event/EventEmitter.js';
import { bufferEvents } from '../util/event/EventBuffer.js';
import { byId, instantiateTemplate, hasClass, getChildWithClassName, createEl, registerTemplates } from '../util/dom/dom.js';
import pivotTableTemplatesHtml from './templates.html?raw';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { ContextMenu } from '../ContextMenu/ContextMenu.js';
import { TupleSet } from '../DataSet/TupleSet.js';
import { CellSet } from '../DataSet/CellSet.js';
import { QueryModel, QueryAxisItem, queryModel } from '../QueryModel/QueryModel.js';
import { AttributeUi } from '../AttributeUi/AttributeUi.js';
import { FilterDialog } from '../FilterUi/FilterUi.js';
import { PivotTableUiHighlighting } from './PivotTableUiHighlighting.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { ExportUi } from '../ExportUi/ExportDialog.js';
import { copyToClipboard } from '../util/clipboard/clipboard.js';
import { getDuckDbLiteralForValue, quoteStringLiteral } from '../util/sql/SQLHelper.js';
import {
  pivotTableUiDefaults,
  getTotalsItemsIndices as _getTotalsItemsIndices,
  isTotalsMember as _isTotalsMember,
  getDittoMark as _getDittoMark,
  getHideRepeatingAxisValues as _getHideRepeatingAxisValues,
  getMaxCellWidth as _getMaxCellWidth,
} from './PivotTableUiUtils.js';

export class PivotTableUi extends EventEmitter {

  static #templateId = pivotTableUiDefaults.templateId;

  #id = undefined;
  #queryModel = undefined;
  #settings = undefined;

  #columnsTupleSet = undefined;
  #rowsTupleSet = undefined;
  #cellsSet = undefined;

  #resizeObserver = undefined;
  #resizeTimeoutId = undefined;
  #resizeTimeout = 150;
  #scrollTimeout = 150;

  #columnHeaderResizeTimeout = 150;
  #columnHeaderResizeTimeoutId = undefined;

  // the maximum width in ch units
  static #maximumCellWidth = pivotTableUiDefaults.maximumCellWidth;

  #lastMetrics = undefined;
  #lastProgressMessage = '';

  constructor(config){
    super(['updated', 'busy', 'progress']);
    registerTemplates(pivotTableTemplatesHtml);
    this.#initDom(config);
    this.#id = config.id;

    this.#initSettings(config.settings);

    const queryModel = config.queryModel;
    this.#queryModel = queryModel;

    const columnsTupleSet = new TupleSet(this.#queryModel, QueryModel.AXIS_COLUMNS, this.#settings);
    this.#columnsTupleSet = columnsTupleSet;
    const rowsTupleSet = new TupleSet(this.#queryModel, QueryModel.AXIS_ROWS, this.#settings);
    this.#rowsTupleSet = rowsTupleSet;

    this.#cellsSet = new CellSet(
      this.#queryModel, [
        rowsTupleSet,
        columnsTupleSet,
      ],
      this.#settings
    );

    this.#initQueryModelChangeHandler()
    this.#initScrollHandler();
    this.#initResizeObserver();
    this.#initCancelQueryButtonClickHandler();

  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  #initDom(config) {
    const dom = instantiateTemplate(PivotTableUi.#templateId, config.id)

    let container = config.container;
    switch (typeof container){
      case 'string':
        container = byId(config.container);
    }

    container.appendChild(dom);
  }

  #getTotalsString(_axisItem){
    const generalSettings = this.#settings.getSettings('pivotSettings');
    const totalsString = generalSettings.totalsString;
    return totalsString;
  }

  getQueryModel(){
    return this.#queryModel;
  }

  #initCancelQueryButtonClickHandler(){
    byId('cancelQueryButton')
    .addEventListener(
      'click',
      this.#cancelQueryButtonClicked.bind(this)
    );
  }

  #cancelQueryButtonClicked(_event){
    void Promise.allSettled([
      this.#columnsTupleSet.cancelPendingQuery(),
      this.#rowsTupleSet.cancelPendingQuery(),
      this.#cellsSet.cancelPendingQuery()
    ]);
    this.#setNeedsUpdate(true);
  }

  #initQueryModelChangeHandler(){
    const queryModel = this.getQueryModel();
    const timeoutCallback = () =>{
      let timeoutValue;
      if (this.#settings){
        if (typeof this.#settings.getSettings === 'function'){
          timeoutValue = this.#settings.getSettings(['querySettings', 'autoRunQueryTimeout']);
        }
        else {
          timeoutValue = this.#settings.autoRunQueryTimeout || 1000;
        }
        if (typeof timeoutValue === 'function'){
          timeoutValue = timeoutValue();
        }
      };
      return timeoutValue;
    };

    bufferEvents(
      queryModel,
      'beforechange',
      this.#queryModelBeforeChangeHandler,
      this,
      timeoutCallback
    );
    bufferEvents(
      queryModel,
      'change',
      this.#queryModelChangeHandler,
      this,
      timeoutCallback
    );
  }

  #initScrollHandler(){
    const container = this.#getInnerContainerDom();
    bufferEvents(
      container,
      'scroll',
      this.#handleInnerContainerScrolled,
      this,
      this.#scrollTimeout
    );
  }

  #initResizeObserver(){
    const dom = this.getDom();

    this.#resizeObserver = new ResizeObserver((entries) =>{
      for (const entry of entries){
        const target = entry.target;
        if (target === dom) {
          this.#handleDomResized();
        }
        else
        if (hasClass(target, 'pivotTableUiHeaderCell')){
          this.#handleColumnHeaderResized(entry);
        }
      }
    });

    this.#resizeObserver.observe(dom);
  }

  #toggleObserveColumnsResizing(onOff){
    const tableHeaderDom = this.#getTableHeaderDom();
    const headerRows = tableHeaderDom.childNodes;
    if (!headerRows.length){
      return;
    }

    let methodName = 'observe';
    if (onOff === false) {
      methodName = 'un' + methodName;
    }
    const method = this.#resizeObserver[methodName];

    const headerRow = headerRows.item(0);
    const columns = headerRow.childNodes;
    for (let i = 0; i < columns.length; i++){
      const column = columns.item(i);
      if (!hasClass(column, 'pivotTableUiHeaderCell')){
        continue;
      }
      if (hasClass(column, 'pivotTableUiStufferCell')){
        continue;
      }
      method.call(this.#resizeObserver, column);
    }
  }

  // ─── Resize / Scroll Handlers ─────────────────────────────────────────────

  #handleDomResized(){
    if (this.#resizeTimeoutId !== undefined) {
      clearTimeout(this.#resizeTimeoutId);
      this.#resizeTimeoutId = undefined;
    }
    this.#resizeTimeoutId = setTimeout(async () =>{
      // we have to check whether it's safe and appropriate to update
      // - if we're already busy, then it's not safe and we shouldn't
      const isSafe = !this.#getBusy();
      // - if autoUpdate is true, it's appropriate
      // - if autoUpdate is not true, and the request was due to a model change then update is not appropriate
      if (isSafe && this.#autoUpdate) {
        await this.updatePivotTableUi();
      }
      else {
        this.#setNeedsUpdate(true);
      }
      clearTimeout(this.#resizeTimeoutId);
      this.#resizeTimeoutId = undefined;
    }, this.#resizeTimeout);
  }

  // this takes a column axis header cell and calculates the corresponding tuple index and cell axis item index
  #getColumnHeaderTupleAndCellAxisInfo(columnHeader){
    const physicalTupleIndices = this.#getPhysicalTupleIndices();

    const physicalColumnsAxisTupleIndex = physicalTupleIndices.physicalColumnsAxisTupleIndex;
    const axisId = QueryModel.AXIS_COLUMNS;
    const _tupleIndexInfo = this.#getTupleIndexForPhysicalIndex(axisId, physicalColumnsAxisTupleIndex);

    const columnsAxisSizeInfo = physicalTupleIndices.columnsAxisSizeInfo;
    const headerCount = columnsAxisSizeInfo.headers.columnCount;

    const headerRow = columnHeader.parentNode;
    const siblings = headerRow.childNodes;
    let physicalColumnIndex;
    for (let i = headerCount; i < siblings.length; i++) {
      if (siblings.item(i) === columnHeader){
        physicalColumnIndex = i;
        break;
      }
    }
    if (physicalColumnIndex === undefined){
      //throw new Error(`Internal error: could not determine physical column index`);
    }
    // TODO: return the actual info
  }

  #handleColumnHeaderResized(resizeEntry) {
    if (this.#columnHeaderResizeTimeoutId !== undefined) {
      clearTimeout(this.#columnHeaderResizeTimeoutId);
      this.#columnHeaderResizeTimeoutId = undefined;
    }
    this.#columnHeaderResizeTimeoutId = setTimeout(() =>{
      const target = resizeEntry.target;
      const width = target.style.width;
      if (width.endsWith('px')) {
        // user changed column width - this is where we should store the width in the corresponding column tuple.
        const _info = this.#getColumnHeaderTupleAndCellAxisInfo(target);
      }
      clearTimeout(this.#columnHeaderResizeTimeoutId);
      this.#columnHeaderResizeTimeoutId = undefined;
    }, this.#columnHeaderResizeTimeout);
  }

  // ─── Settings / State ─────────────────────────────────────────────────────

  #initSettings(settings){
    this.#settings = settings;
  }

  get #autoUpdate(){
    let autoUpdate;
    let settings = this.#settings || {};
    if (settings && typeof settings.getSettings === 'function'){
      settings = settings.getSettings('querySettings');
    }
    if (settings.autoRunQuery !== undefined) {
      autoUpdate = settings.autoRunQuery;
    }
    else {
      autoUpdate = false;
    }
    return autoUpdate;
  }

  #setNeedsUpdate(needsUpdate){
    const dom = this.getDom();
    dom.setAttribute('data-needs-update', String(Boolean(needsUpdate)));
  }

  #queryModelStateBeforeChange = undefined;
  #queryModelFilterConditionBeforeChange = undefined;
  #queryModelBeforeChangeHandler(event, count){
    if (count !== 0) {
      return;
    }
    const queryModelState = this.#queryModel.getState({includeItemIndices: true});
    this.#queryModelStateBeforeChange = JSON.stringify(queryModelState);
    this.#queryModelFilterConditionBeforeChange = this.#queryModel.getFilterConditionSql(false);
  }

  async #queryModelChangeHandler(event, count){
    if (count !== undefined) {
      return;
    }
    const stateBefore = this.#queryModelStateBeforeChange;

    const queryModelStateAfterChange = this.#queryModel.getState({includeItemIndices: true});
    const stateAfter = JSON.stringify(queryModelStateAfterChange);
    if (stateBefore === stateAfter){
      this.#queryModelStateBeforeChange = undefined;
      return;
    }
    const queryModelStateBeforeChange = JSON.parse(stateBefore);

    let needsClearing = false;
    let needsUpdate = false;

    let clearRowsTupleSet = false;
    let clearColumnsTupleSet = false;
    let clearCellsSet = false;

    const stateChange = QueryModel.compareStates(queryModelStateBeforeChange, queryModelStateAfterChange);
    const axesChangedInfo = stateChange.axesChanged;
    if (axesChangedInfo){

      if (axesChangedInfo[QueryModel.AXIS_ROWS] !== undefined) {
        clearCellsSet = clearRowsTupleSet = true;
      }

      if (axesChangedInfo[QueryModel.AXIS_COLUMNS] !== undefined) {
        clearCellsSet = clearColumnsTupleSet = true;
      }

      if (axesChangedInfo[QueryModel.AXIS_CELLS] !== undefined) {
        needsUpdate = true;
        if (!clearCellsSet) {
          // NOOP!

          // This case is special - it means only the cells axis changed
          // But adding or removing items to only the cellset does not require clearing of the cells,
          // as we store aggregate items together and separately in the cell data.
        }
      }

      if (axesChangedInfo[QueryModel.AXIS_FILTERS]) {
        const filterConditionSql = this.#queryModel.getFilterConditionSql(false);
        if (filterConditionSql !== this.#queryModelFilterConditionBeforeChange) {
          needsUpdate = true;
          clearCellsSet = clearColumnsTupleSet = clearRowsTupleSet = true;
        }
      }
    }

    if (stateChange.propertiesChanged){
      const propertiesChangedInfo = stateChange.propertiesChanged;

      if (propertiesChangedInfo.datasource || propertiesChangedInfo.datasourceId) {
        clearCellsSet = clearRowsTupleSet = clearColumnsTupleSet = true;
        const hadDatasourceBefore = queryModelStateBeforeChange && (queryModelStateBeforeChange.datasourceId || queryModelStateBeforeChange.datasource);
        if (hadDatasourceBefore) {
          needsClearing = true;
        }
      }

      if (propertiesChangedInfo.cellsHeaders){
        // moving cells to another axis does not change the tuples or the cached cells,
        // it only requires rerendering the table.
        needsUpdate = true;
      }
    }

    // only clear tuple sets or cellset if the change requires it.
    if (clearColumnsTupleSet) {
      const columnsTupleSet = this.#columnsTupleSet;
      columnsTupleSet.clearCache();
      needsUpdate = true;
    }

    if (clearRowsTupleSet === true) {
      const rowsTupleSet = this.#rowsTupleSet;
      rowsTupleSet.clearCache();
      needsUpdate = true;
    }

    if (clearCellsSet === true) {
      const cellsSet = this.#cellsSet;
      cellsSet.clearCache();
      needsUpdate = true;
    }

    const countQueryAxisItems = [
      QueryModel.AXIS_ROWS,
      QueryModel.AXIS_COLUMNS,
      QueryModel.AXIS_CELLS
    ].reduce((acc, curr) =>{
      const queryModel = this.getQueryModel();
      const queryAxis = queryModel.getQueryAxis(curr);
      const queryAxisItems = queryAxis.getItems();
      return acc + queryAxisItems.length;
    }, 0);

    if (countQueryAxisItems === 0) {
      needsClearing = true;
    }

    if (needsClearing) {
      this.clear();
    }

    this.#setNeedsUpdate(needsUpdate);

    if (!this.#autoUpdate){
      this.#queryModelStateBeforeChange = undefined;
      return;
    }

    if (needsUpdate){
      await this.updatePivotTableUi();
    }
    this.#queryModelStateBeforeChange = undefined;
  }

  #setBusy(busy){
    const dom = this.getDom();
    dom.setAttribute('aria-busy', String(Boolean(busy)));
    if (!busy) {
      this.#setProgressMessage('');
    }
    this.fireEvent('busy', {
      busy: Boolean(busy)
    })
  }

  #getBusy(){
    const dom = this.getDom();
    return dom.getAttribute('aria-busy') === 'true';
  }

  #setProgressMessage(message){
    const nextMessage = message ? String(message) : '';
    if (nextMessage === this.#lastProgressMessage) {
      return;
    }
    this.#lastProgressMessage = nextMessage;
    this.fireEvent('progress', {
      message: nextMessage
    });
  }

  #fireUpdatedSuccess(){
    const tupleCounts = {};
    tupleCounts[QueryModel.AXIS_ROWS] = this.#rowsTupleSet.getTupleCountSync();
    tupleCounts[QueryModel.AXIS_COLUMNS] = this.#columnsTupleSet.getTupleCountSync();
    
    const queryModel = this.getQueryModel();
    tupleCounts[QueryModel.AXIS_CELLS] = {
      axis: queryModel.getCellHeadersAxis(),
      count: queryModel.getCellsAxis().getItems().length
    };
    
    const status = {
      status: 'success',
      tupleCounts: tupleCounts,
      metrics: this.#lastMetrics
    }
    this.fireEvent('updated', status);
  }

  async #handleInnerContainerScrolled(event, count){
    if (count === undefined){
      // this is the last scroll event, update the table contents.
      if (this.#queryModelStateBeforeChange || this.#getBusy()){
        // if the table is scrolled while it is being changed, don't entertain the scroll request.
        // https://github.com/rpbouman/huey/issues/360
        return;
      }
      try {
        this.#setBusy(true);
        this.#setProgressMessage('Updating visible rows and cells...');
        await this.#updateDataToScrollPosition();
        this.#fireUpdatedSuccess();
      }
      catch(error){
        console.error(error);
        this.fireEvent('updated', {
          status: 'error',
          error: error
        });
      }
      finally {
        setTimeout(this.#setBusy.bind(this), 1);
      }
    }
    else
    if (count !== 0) {
      return;
    }
  }

  // ─── Geometry / Tuple Index Calculations ──────────────────────────────────

  #getPhysicalTupleIndices(){
    const innerContainer = this.#getInnerContainerDom();

    //
    const scrollWidth = innerContainer.scrollWidth;
    const left = innerContainer.scrollLeft;

    const columnsAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    const headersWidth = columnsAxisSizeInfo ? columnsAxisSizeInfo.headers.width : 0;
    const horizontallyScrolledFraction = left / (scrollWidth - headersWidth);
    const numberOfPhysicalColumnsAxisTuples = this.#getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_COLUMNS);
    const physicalColumnsAxisTupleIndex = Math.ceil(numberOfPhysicalColumnsAxisTuples * horizontallyScrolledFraction);

    //
    const scrollHeight = innerContainer.scrollHeight;
    const top = innerContainer.scrollTop;

    const rowsAxisSizeInfo = this.#getRowsAxisSizeInfo();
    const headersHeight = rowsAxisSizeInfo.headers.height;
    const verticallyScrolledFraction = top / (scrollHeight - headersHeight);
    const numberOfPhysicalRowsAxisTuples = this.#getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_ROWS);
    const physicalRowsAxisTupleIndex = Math.ceil(numberOfPhysicalRowsAxisTuples * verticallyScrolledFraction);

    return {
      columnsAxisSizeInfo: columnsAxisSizeInfo,
      physicalColumnsAxisTupleIndex: physicalColumnsAxisTupleIndex,
      rowsAxisSizeInfo: rowsAxisSizeInfo,
      physicalRowsAxisTupleIndex: physicalRowsAxisTupleIndex
    };
  }

  async #updateDataToScrollPosition(){
    const physicalTupleIndices = this.#getPhysicalTupleIndices();

    let physicalColumnsAxisTupleIndex = physicalTupleIndices.physicalColumnsAxisTupleIndex;
    
    // ensure we don't overshoot 
    const tupleIndexInfo = this.#getTupleIndexForPhysicalIndex(QueryModel.AXIS_COLUMNS, physicalColumnsAxisTupleIndex);
    const columnsAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    if (!columnsAxisSizeInfo){
      return;
    }
    
    const count = columnsAxisSizeInfo.columns ? columnsAxisSizeInfo.columns.columnCount : 0;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex){
      tupleCount += 1;
    }
    const allTupleCount = this.#getEffectiveTupleCountForAxis(QueryModel.AXIS_COLUMNS);
    if (tupleIndexInfo.tupleIndex + tupleCount >= allTupleCount) {
      const maxPhysicalColumn = allTupleCount * tupleIndexInfo.factor;
      physicalColumnsAxisTupleIndex = maxPhysicalColumn - count;
    }
    
    const physicalRowsAxisTupleIndex = physicalTupleIndices.physicalRowsAxisTupleIndex;

    const columnAxisPromise = this.#updateColumnsAxisTupleData(physicalColumnsAxisTupleIndex);
    const rowAxisPromise = this.#updateRowsAxisTupleData(physicalRowsAxisTupleIndex);

    await Promise.all([columnAxisPromise, rowAxisPromise]);
    await this.#updateCellData(physicalColumnsAxisTupleIndex, physicalRowsAxisTupleIndex);
  }

  #getTupleIndexForPhysicalIndex(axisId, physicalIndex){
    const queryModel = this.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    let factor;
    if (cellHeadersAxis === axisId){
      const cellsAxis = queryModel.getCellsAxis();
      const cellsAxisItems = cellsAxis.getItems();
      const numCellsAxisItems = cellsAxisItems.length;
      if (numCellsAxisItems === 0) {
        factor = 1;
      }
      else {
        factor = numCellsAxisItems;
      }
    }
    else {
      factor = 1;
    }
    const fractionalIndex = physicalIndex / factor;
    const tupleIndex = Math.floor(fractionalIndex);
    const fraction = fractionalIndex - tupleIndex;
    const cellsAxisItemIndex = Math.round(fraction * factor);

    return {
      physicalIndex: physicalIndex,
      axisId: axisId,
      factor: factor,
      tupleIndex: tupleIndex,
      cellsAxisItemIndex: cellsAxisItemIndex
    };
  }

  static #getTotalsItemsIndices(queryAxisItems){
    return _getTotalsItemsIndices(queryAxisItems);
  }

  static #isTotalsMember(groupingId, totalsItemsIndices, currentItemIndex){
    return _isTotalsMember(groupingId, totalsItemsIndices, currentItemIndex);
  }

  #getTupleGroupingId(tuple){
    return tuple ? tuple[TupleSet.groupingIdAlias] : undefined;
  }
  

  async #updateColumnsAxisTupleData(physicalColumnsAxisTupleIndex){
    if (isNaN(physicalColumnsAxisTupleIndex)) {
      return;
    }
    let repeatingValuesIndex;
    const hideRepeatingAxisValues = this.#getHideRepeatingAxisValues();
    const dittoMark = hideRepeatingAxisValues ? this.#getDittoMark() : '';

    const axisId = QueryModel.AXIS_COLUMNS;
    const tupleIndexInfo = this.#getTupleIndexForPhysicalIndex(axisId, physicalColumnsAxisTupleIndex);
    const columnsAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    const count = columnsAxisSizeInfo.columns.columnCount;
    const maxColumnIndex = columnsAxisSizeInfo.headers.columnCount + count;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex) {
      tupleCount += 1;
    }
    const tupleSet = this.#columnsTupleSet;
    const lastTupleIndex = this.#getEffectiveTupleCountForAxis(axisId) - 1;

    const queryModel = this.getQueryModel();
    const queryAxis = queryModel.getColumnsAxis();
    const queryAxisItems = queryAxis.getItems();
    const totalsItemsIndices = PivotTableUi.#getTotalsItemsIndices(queryAxisItems);

    const tupleValueFields = tupleSet.getTupleValueFields();
    let tupleValueField;

    const tuples = await tupleSet.getTuples(tupleCount, tupleIndexInfo.tupleIndex);
    // local tuple index in our array of tuples
    let tupleIndex = 0;

    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    let cellsAxisItems, _numCellsAxisItems;
    let doCellHeaders = (cellHeadersAxis === axisId);
    if (doCellHeaders) {
      const cellsAxis = queryModel.getCellsAxis();
      cellsAxisItems = cellsAxis.getItems();
      if (cellsAxisItems.length === 0){
        doCellHeaders = false;
      }
    }

    let cellsAxisItemIndex = tupleIndexInfo.cellsAxisItemIndex;

    const tableHeaderDom = this.#getTableHeaderDom();
    const rows = tableHeaderDom.childNodes;
    const numRows = rows.length;

    // for each tuple
    const columnsOffset = columnsAxisSizeInfo.headers.columnCount;
    for (let i = columnsOffset; i < maxColumnIndex; i++){
      const tuple = tuples[tupleIndex];
      const prevTuple = tuples[tupleIndex - 1];
      repeatingValuesIndex = undefined;

      const groupingId = this.#getTupleGroupingId(tuple);

      //for each header row
      for (let j = 0; j < numRows; j++){
        const queryAxisItem = queryAxisItems[j];

        const row = rows.item(j);
        const cells = row.childNodes;
        const cell = cells.item(i);
        cell.setAttribute('data-column-index', tupleIndex);
        cell.setAttribute('data-column-tuple-index', tupleIndexInfo.tupleIndex + tupleIndex);
        cell.setAttribute('data-is-last-column-tuple', (tupleIndexInfo.tupleIndex + tupleIndex) === lastTupleIndex);
        
        const label = getChildWithClassName(cell, 'pivotTableUiCellLabel');
        const isTotalsMember = PivotTableUi.#isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : numRows - 1);
        cell.setAttribute('data-totals', isTotalsMember <= j);
        cell.setAttribute('data-totals-origin', isTotalsMember === j);
        if (doCellHeaders){
          cell.setAttribute('data-cells-axis-item-index', cellsAxisItemIndex);
        }

        let labelText = undefined;
        let titleText = undefined;
        let tupleValue;
        if (tuple && j < tuple.values.length){
          tupleValueField = tupleValueFields[j];
          tupleValue = tuple.values[j];
          if (hideRepeatingAxisValues && prevTuple && (repeatingValuesIndex === undefined || repeatingValuesIndex === j - 1)){
            const prevTupleValue = prevTuple.values[j];
            if (
              tupleValue !== null && tupleValue === prevTupleValue ||
              tupleValue === null && prevTupleValue === null &&
              isTotalsMember ===  PivotTableUi.#isTotalsMember(
                this.#getTupleGroupingId(prevTuple),
                totalsItemsIndices,
                queryAxisItem ? j : numRows - 1
              )
            ){
              repeatingValuesIndex = j;
            }
            else
            if (repeatingValuesIndex === undefined){
              repeatingValuesIndex = j - 1;
            }
          }

          this.#setCellValueLiteral(cell, queryAxisItem, tupleValue, tupleValueField);

          if (isTotalsMember > j) {
            if (queryAxisItem && queryAxisItem.formatter) {
              titleText = queryAxisItem.formatter(tupleValue, tupleValueField);
            }
            else {
              titleText = String(tupleValue);
            }
            if (cellsAxisItemIndex === 0 || i === columnsOffset) {
              labelText = titleText;
            }
          }
          else
          if (isTotalsMember === j){
            titleText = queryAxisItem ? this.#getTotalsString(queryAxisItem) : '';
            if (cellsAxisItemIndex === 0 || i === columnsOffset){
              labelText = titleText;
            }
          }
          else {
            labelText = '';
          }
          titleText = queryAxisItem ? `${QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem)} (${tupleIndex + 1}): ${titleText}` : `${tupleIndex + 1}: ${titleText}`;

          if (hideRepeatingAxisValues){
            let isRepeatingValue;
            if (
              repeatingValuesIndex === j || 
              doCellHeaders && cellsAxisItems.length && (cellsAxisItemIndex > 0 && i !== columnsOffset)
            ){
              labelText = isTotalsMember <= j ? undefined : dittoMark;
              isRepeatingValue = true;
            }
            else {
              isRepeatingValue = false;
            }
            cell.setAttribute('data-is-repeating-value', isRepeatingValue);
          }
          else {
            cell.removeAttribute('data-is-repeating-value');
          }
        }
        else
        if (doCellHeaders && cellsAxisItems.length) {
          const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
          this.#setCellItemId(cell, cellsAxisItem, cellsAxisItemIndex);
          titleText = labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
        }

        if (!labelText || !labelText.length) {
          labelText = String.fromCharCode(160);
        }

        label.textContent = labelText;
        label.title = titleText;

        if (j === 0){
          if (tuple && tuple.widths) {
            const cellsAxisItem = cellsAxisItems.length === 0 ? null : cellsAxisItems[cellsAxisItemIndex];
            const cellsAxisItemLabel = cellsAxisItems.length === 0 ? '' : QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem);
            const width = tuple.widths[cellsAxisItemLabel];
            if (width !== undefined) {
              cell.style.width = width + 'px';
            }
          }
        }

      }

      if (doCellHeaders) {
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex === cellsAxisItems.length) {
          cellsAxisItemIndex = 0;
          tupleIndex += 1;
        }
      }
      else {
        tupleIndex += 1;
      }
    }
  }

  async #updateRowsAxisTupleData(physicalRowsAxisTupleIndex){
    let repeatingValuesIndex;
    const hideRepeatingAxisValues = this.#getHideRepeatingAxisValues();
    const dittoMark = hideRepeatingAxisValues ? this.#getDittoMark() : '';
    
    const axisId = QueryModel.AXIS_ROWS;
    const tupleIndexInfo = this.#getTupleIndexForPhysicalIndex(axisId, physicalRowsAxisTupleIndex);
    const rowsAxisSizeInfo = this.#getRowsAxisSizeInfo();
    const columnsAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    const count = rowsAxisSizeInfo.rows.rowCount;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex > 0) {
      tupleCount += 1;
    }      
    const tupleSet = this.#rowsTupleSet;
    const lastTupleIndex = this.#getEffectiveTupleCountForAxis(axisId) - 1;

    const queryModel = this.getQueryModel();
    const queryAxis = queryModel.getRowsAxis();
    const queryAxisItems = queryAxis.getItems();
    const totalsItemsIndices = PivotTableUi.#getTotalsItemsIndices(queryAxisItems);

    const tupleValueFields = tupleSet.getTupleValueFields();
    const tuples = await tupleSet.getTuples(tupleCount, tupleIndexInfo.tupleIndex || 0);

    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    let cellsAxisItems;
    const doCellHeaders = (cellHeadersAxis === axisId);
    if (doCellHeaders) {
      const cellsAxis = queryModel.getCellsAxis();
      cellsAxisItems = cellsAxis.getItems();
    }

    let tupleIndex = 0;
    let cellsAxisItemIndex = tupleIndexInfo.cellsAxisItemIndex;

    const tableBodyDom = this.#getTableBodyDom();
    const rows = tableBodyDom.childNodes;

    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows.item(i);
      const cells = row.childNodes;

      const tuple = tuples[tupleIndex];
      const prevTuple = tuples[tupleIndex - 1];
      repeatingValuesIndex = undefined;

      row.setAttribute('data-row-index', tupleIndex);
      row.setAttribute('data-row-tuple-index', tupleIndexInfo.tupleIndex + tupleIndex);
      row.setAttribute('data-is-last-row-tuple', (tupleIndexInfo.tupleIndex + tupleIndex) === lastTupleIndex || isNaN(lastTupleIndex) );
      
      const groupingId = this.#getTupleGroupingId(tuple);

      const isTotalsRow = Boolean(groupingId);
      row.setAttribute('data-totals', isTotalsRow);

      const columnsOffset = columnsAxisSizeInfo.headers.columnCount;
      for (let j = 0; j < columnsOffset; j++){
        const queryAxisItem = queryAxisItems[j];
        const cell = cells.item(j);
        const label = getChildWithClassName(cell, 'pivotTableUiCellLabel');

        let labelText = undefined;
        let titleText = undefined;
        const numMembers = tuple ? tuple.values.length : 0;
        const isTotalsMember = PivotTableUi.#isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : undefined);
        let isTotals = false;
        let isTotalsOrigin = false;
        
        if (tuple && j < numMembers) {
          const tupleValue = tuple.values[j];

          if (hideRepeatingAxisValues && prevTuple && (repeatingValuesIndex === undefined || repeatingValuesIndex === j - 1)){
            const prevTupleValue = prevTuple.values[j];
            if (
              tupleValue !== null && tupleValue === prevTupleValue ||
              tupleValue === null && prevTupleValue === null &&
              isTotalsMember ===  PivotTableUi.#isTotalsMember(
                this.#getTupleGroupingId(prevTuple),
                totalsItemsIndices,
                queryAxisItem ? j : numRows - 1
              )
            ){
              repeatingValuesIndex = j;
            }
            else
            if (repeatingValuesIndex === undefined){
              repeatingValuesIndex = j - 1;
            }
          }

          const tupleValueField = tupleValueFields[j];
          this.#setCellValueLiteral(cell, queryAxisItem, tupleValue, tupleValueField);
          if (isTotalsMember > j) {
            if (queryAxisItem && queryAxisItem.formatter) {
              labelText = queryAxisItem.formatter(tupleValue, tupleValueField);
            }
            else {
              labelText = String(tupleValue);
            }
          }
          else
          if (isTotalsMember === j) {
            isTotals = isTotalsOrigin = true;
            if (doCellHeaders){
              if (i === 0 || cellsAxisItemIndex === 0){
                labelText = queryAxisItem ? this.#getTotalsString(queryAxisItem) : '';
              }
              else {
                labelText = undefined;
              }
            }
            else {
              labelText = queryAxisItem ? this.#getTotalsString(queryAxisItem) : '';
            }
          }
          else {
            labelText = '';
            isTotals = true;
          }
          titleText = queryAxisItem ? `${QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem)}: ${labelText}` : String(labelText);

          if (hideRepeatingAxisValues){
            let isRepeatingValue;
            if (
              repeatingValuesIndex === j ||
              doCellHeaders && cellsAxisItems.length && (cellsAxisItemIndex > 0 && i !== 0)
            ){
              // add ditto marks, unless this is a totals cell
              labelText = isTotalsMember <= j ? undefined : dittoMark;
              isRepeatingValue = true;
            }
            else {
              isRepeatingValue = false;
            }
            cell.setAttribute('data-is-repeating-value', isRepeatingValue);
          }
          else {
            cell.removeAttribute('data-is-repeating-value');
          }
        }
        else
        if (doCellHeaders && j === columnsOffset - 1) {
          const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
          labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
          titleText = labelText;
          isTotals = isTotalsRow;
          cell.setAttribute('data-axis-item', QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem));
          cell.setAttribute('data-axis-item-index', cellsAxisItemIndex);
        }

        if (!labelText || !labelText.length) {
          labelText = String.fromCharCode(160);
        }

        label.textContent = labelText;
        label.title = titleText;
        
        if (isTotals){
          cell.setAttribute('data-totals', isTotals);
        }
        else {
          cell.removeAttribute('data-totals');
        }
        
        if (isTotalsOrigin) {
          cell.setAttribute('data-totals-origin', isTotalsOrigin);
        }
        else {
          cell.removeAttribute('data-totals-origin');
        }
        
      }

      if (doCellHeaders) {
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex === cellsAxisItems.length || cellsAxisItems.length === 0) {
          cellsAxisItemIndex = 0;
          tupleIndex += 1;
        }
      }
      else {
        tupleIndex += 1;
      }
    }
  }

  #setCellItemId(cellElement, queryAxisItem, queryAxisItemIndex){
    if (!queryAxisItem){
      return;
    }
    cellElement.setAttribute('data-axis', queryAxisItem.axis);
    const itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
    cellElement.setAttribute('data-axis-item', itemId);
    cellElement.setAttribute('data-axis-item-index', queryAxisItemIndex);
  }

  #setCellValueLiteral(cellElement, queryAxisItem, tupleValue, tupleValueField){
    if (!queryAxisItem){
      console.warn(`No query axis item!`);
      return;
    }

    if (!tupleValue && !tupleValueField) {
      // this really should't happen but sometimes does when the cached tuples are out of sync witht he query model.
      console.warn(`No tuple value and no tuple value field.`);
      return;
    }

    if (!tupleValueField?.type || tupleValueField.type.typeId === null) {
      // Remote tuple sets may provide fields without type (e.g. { name } only); set a safe literal and type.
      const safeLiteral = tupleValue === null ? 'NULL' : (typeof tupleValue === 'string' ? quoteStringLiteral(tupleValue) : String(tupleValue));
      cellElement.setAttribute('data-value-literal', safeLiteral);
      cellElement.setAttribute('data-value-type', queryAxisItem.columnType || 'VARCHAR');
      cellElement.setAttribute('data-axis', queryAxisItem.axis);
      cellElement.setAttribute('data-axis-item', QueryAxisItem.getIdForQueryAxisItem(queryAxisItem));
      return;
    }

    switch (tupleValueField.type.typeId){
      case 12:  // variable size list
        if (tupleValue !== null){
          console.warn(`Tuple value is a variable length list. Refuse to write out its literal value.`);
        }
        return;
      default:
    }

    cellElement.setAttribute('data-axis', queryAxisItem.axis);

    const itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
    cellElement.setAttribute('data-axis-item', itemId);

    let valueLiteral;
    const literalWriter = queryAxisItem.literalWriter;
    if (literalWriter){
      valueLiteral = literalWriter(tupleValue, tupleValueField);
    }
    else {
      valueLiteral = getDuckDbLiteralForValue(tupleValue, tupleValueField.type);
    }
    cellElement.setAttribute('data-value-literal', valueLiteral);

    let cellValueType = String(tupleValueField.type);
    if (queryAxisItem.derivation) {
      const derivationInfo = AttributeUi.getDerivationInfo(queryAxisItem.derivation);
      if (derivationInfo.dataValueTypeOverride) {
        cellValueType = derivationInfo.dataValueTypeOverride;
      }
    }
    cellElement.setAttribute('data-value-type', cellValueType);
  }

  #renderCellValue(cell, cellsAxisItem, cellElement){
    const label = getChildWithClassName(cellElement, 'pivotTableUiCellLabel');
    if (!cell || !cellsAxisItem){
      label.title = '';
      return label.textContant = '';
    }

    const values = cell.values;
    const sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(cellsAxisItem, CellSet.datasetRelationName);
    const value = values[sqlExpression];

    const cellValueFields = this.#cellsSet.getCellValueFields();
    const cellValueField = cellValueFields[sqlExpression];
    this.#setCellValueLiteral(cellElement, cellsAxisItem, value, cellValueField);

    let labelText;
    const formatter = cellsAxisItem.formatter;

    if (formatter) {
      labelText = formatter(value, cellValueField);
    }
    else
    if (value === null){
      labelText = '';
    }
    else {
      labelText = String(value);
    }
    label.textContent = labelText;

    const caption = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
    label.title = `${caption}: ${labelText}`;
    return labelText
  }

  async #updateCellData(physicalColumnsAxisTupleIndex, physicalRowsAxisTupleIndex){
    const tableBodyDom = this.#getTableBodyDom();
    const tableBodyRows = tableBodyDom.childNodes;

    const tableHeaderDom = this.#getTableHeaderDom();
    const tableHeaderRows = tableHeaderDom.childNodes;
    const firstTableHeaderRow = tableHeaderRows.item(0);
    const firstTableHeaderRowCells = firstTableHeaderRow.childNodes;

    const lastTableHeaderRow = tableHeaderRows.item(tableHeaderRows.length - 1);
    const lastTableHeaderRowCells = lastTableHeaderRow.childNodes;

    const queryModel = this.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();

    const rowsAxis = queryModel.getRowsAxis();
    const rowsAxisItems = rowsAxis.getItems();
    const columnsAxis = queryModel.getColumnsAxis();
    const columnsAxisItems = columnsAxis.getItems();
    const cellsAxis = queryModel.getCellsAxis();
    const cellsAxisItems = cellsAxis.getItems();
    let _itemId;

    const columnTupleIndexInfo = this.#getTupleIndexForPhysicalIndex(QueryModel.AXIS_COLUMNS, physicalColumnsAxisTupleIndex);
    const columnsAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    const headerColumnCount = columnsAxisSizeInfo.headers.columnCount;

    const rowTupleIndexInfo = this.#getTupleIndexForPhysicalIndex(QueryModel.AXIS_ROWS, physicalRowsAxisTupleIndex);

    const _rowCount = tableBodyRows.length - 1;
    const columnCount = firstTableHeaderRowCells.length - headerColumnCount - 1;

    let columnsAxisTupleIndex = columnTupleIndexInfo.tupleIndex;
    let rowsAxisTupleIndex = rowTupleIndexInfo.tupleIndex;
    let numRowsAxisTuples, numColumnsAxisTuples;
    let columnsTupleRange = [];
    let rowsTupleRange = [];
    switch (cellHeadersAxis){
      case QueryModel.AXIS_COLUMNS:
        if (columnsAxisItems.length){
          numColumnsAxisTuples = Math.ceil(columnCount / columnTupleIndexInfo.factor);
          if (columnTupleIndexInfo.cellsAxisItemIndex) {
            numColumnsAxisTuples += 1;
          }
        }
        else {
          numColumnsAxisTuples = cellsAxisItems.length ? 1 : 0;
        }
        numRowsAxisTuples = rowsAxisItems.length ? tableBodyRows.length - 1 : 0;
        break;
      case QueryModel.AXIS_ROWS:
        numColumnsAxisTuples = columnsAxisItems.length ? columnCount : 0;
        if (rowsAxisItems.length){
          numRowsAxisTuples = Math.ceil((tableBodyRows.length - 1) / rowTupleIndexInfo.factor);
          if (rowTupleIndexInfo.cellsAxisItemIndex){
            numRowsAxisTuples += 1;
          }
        }
        else {
          numRowsAxisTuples = cellsAxisItems.length ? 1 : 0;
        }
        break;
    }
    columnsTupleRange = [columnsAxisTupleIndex, columnsAxisTupleIndex + numColumnsAxisTuples];
    rowsTupleRange = [rowsAxisTupleIndex, rowsAxisTupleIndex + numRowsAxisTuples];

    let cellsAxisItemIndex;

    const cellsSet = this.#cellsSet;
    const cells = await cellsSet.getCells([rowsTupleRange, columnsTupleRange]);

    let _cellIndex;

    for (let i = 0; i < tableBodyRows.length - 1; i++){
      const tableRow = tableBodyRows.item(i);
      if (!tableRow){
        continue;
      }
      const isTotalsRow = tableRow.getAttribute('data-totals') === 'true';
      const cellElements = tableRow.childNodes;

      if (cellHeadersAxis === QueryModel.AXIS_ROWS && i === 0){
        cellsAxisItemIndex = rowTupleIndexInfo.cellsAxisItemIndex;
        rowsAxisTupleIndex = rowTupleIndexInfo.tupleIndex;
      }

      for (let j = headerColumnCount; j < headerColumnCount + columnCount; j++){

        if (j === headerColumnCount) {
          columnsAxisTupleIndex = columnTupleIndexInfo.tupleIndex;
          if (cellHeadersAxis === QueryModel.AXIS_COLUMNS) {
            cellsAxisItemIndex = columnTupleIndexInfo.cellsAxisItemIndex;
          }
        }

        const cellElement = cellElements.item(j);
        if (!cellElement){
          console.warn(`Warning: no DOM found for cell ${i},${j}`);
          continue;
        }
                
        const cellIndex = cellsSet.getCellIndex(rowsAxisTupleIndex, columnsAxisTupleIndex);
        let cell = undefined;
        if (cells) {
          cell = cells[cellIndex];
        }
        const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
        const labelText = this.#renderCellValue(cell, cellsAxisItem, cellElement);

        const headerCell = firstTableHeaderRowCells.item(j);
        if (headerCell) {
          const lastTableHeaderRowCell = lastTableHeaderRowCells.item(j);
          if (isTotalsRow || (lastTableHeaderRowCell ? lastTableHeaderRowCell.getAttribute('data-totals') === 'true' : false) ){
            cellElement.setAttribute('data-totals', true);
          }
          else {
            cellElement.removeAttribute('data-totals');
          }
          // adjust the column width if necessary.
          const width = headerCell.style.width;
          if (width.endsWith('ch')){
            let newWidth = labelText.length + 1;

            if (newWidth > PivotTableUi.#maximumCellWidth) {
              newWidth = PivotTableUi.#maximumCellWidth;
            }

            if (newWidth > parseInt(width, 10)) {
              headerCell.style.width = newWidth + 'ch';
            }
          }
        }
        else {
          console.warn(`Warning: no header cell at position ${j}`);
        }

        if (cellHeadersAxis === QueryModel.AXIS_COLUMNS){
          cellElement.setAttribute('data-cells-axis-item-index', cellsAxisItemIndex);
          cellsAxisItemIndex += 1;
          if (cellsAxisItemIndex >= cellsAxisItems.length) {
            cellsAxisItemIndex = 0;
            columnsAxisTupleIndex += 1;
          }
        }
        else {
          cellElement.removeAttribute('data-cells-axis-item-index');
          columnsAxisTupleIndex += 1;
        }
      }

      if (cellHeadersAxis === QueryModel.AXIS_ROWS){
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex >= cellsAxisItems.length) {
          cellsAxisItemIndex = 0;
          rowsAxisTupleIndex += 1;
        }
      }
      else {
        rowsAxisTupleIndex += 1;
      }
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  #renderHeader() {
    const tableHeaderDom = this.#getTableHeaderDom();
    const tableBodyDom = this.#getTableBodyDom();

    const queryModel = this.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();

    const rowsAxis = queryModel.getRowsAxis();
    const rowsAxisItems = rowsAxis.getItems();

    const columnsAxis = queryModel.getColumnsAxis();
    const columnsAxisItems = columnsAxis.getItems();

    const cellsAxis = queryModel.getCellsAxis();
    const cellsAxisItems = cellsAxis.getItems();

    let numColumnAxisRows = columnsAxisItems.length;
    if (
      cellHeadersAxis === QueryModel.AXIS_COLUMNS && cellsAxisItems.length ||
      rowsAxisItems.length && columnsAxisItems.length && !cellsAxisItems.length
    ) {
      numColumnAxisRows += 1;
    }
    
    if (numColumnAxisRows === 0) {
      numColumnAxisRows = 1;
    }

    let numRowAxisColumns = rowsAxisItems.length;
    if (cellHeadersAxis === QueryModel.AXIS_ROWS) {
      // make room for the cell headers on the rows axis
      if (columnsAxisItems.length || cellsAxisItems.length) {
        numRowAxisColumns += 1;
      }
    }

    if (numRowAxisColumns === 0) {
      numRowAxisColumns = 1;
    }

    let firstTableHeaderRow, firstTableHeaderRowCells;
    for (let i = 0; i < numColumnAxisRows; i++){
      const tableRow = createEl('div', {
        "class": "pivotTableUiRow",
        "role": "row"
      });
      tableHeaderDom.appendChild(tableRow);

    let tableCell, labelText, label, columnWidth;
      for (let j = 0; j < numRowAxisColumns; j++) {
        tableCell = createEl('div', {
          "class": 'pivotTableUiCell pivotTableUiHeaderCell',
          "role": "columnheader"
        });
        tableRow.appendChild(tableCell);

        // last row in the header section: headers for the  row axis columns
        if (i === (numColumnAxisRows - 1)) {
          if (j < rowsAxisItems.length){
            tableCell.className += ' pivotTableUiRowsAxisHeaderCell';
            const rowsAxisItem = rowsAxisItems[j];
            this.#setCellItemId(tableCell, rowsAxisItem, j);
            labelText = QueryAxisItem.getCaptionForQueryAxisItem(rowsAxisItem);
            columnWidth = (labelText.length + 2);

            if (columnWidth > PivotTableUi.#maximumCellWidth) {
              columnWidth = PivotTableUi.#maximumCellWidth;
            }

            columnWidth += 'ch';
            label = createEl('span', {
              "class": 'pivotTableUiCellLabel pivotTableUiAxisHeaderLabel',
            });
            label.title = labelText;
            label.textContent = labelText;
            tableCell.appendChild(label);
          }
          else
          if (cellHeadersAxis === QueryModel.AXIS_ROWS) {
            columnWidth = rowsAxisItems.reduce((acc, curr) =>{
              labelText = QueryAxisItem.getCaptionForQueryAxisItem(curr);
              columnWidth = labelText.length;
              return columnWidth > acc ? columnWidth : acc;
            }, 0);

            columnWidth += 1;

            if (columnWidth > PivotTableUi.#maximumCellWidth) {
              columnWidth = PivotTableUi.#maximumCellWidth;
            }

            columnWidth += 'ch';
          }

          firstTableHeaderRow = tableHeaderDom.childNodes.item(0);
          firstTableHeaderRowCells = firstTableHeaderRow.childNodes;
          const firstTableHeaderRowCell = firstTableHeaderRowCells.item(j);
          firstTableHeaderRowCell.style.width = columnWidth;
        }
      }

      // headers for the column axis rows
      if (i < columnsAxisItems.length) {
        tableCell.className += ' pivotTableUiColumnsAxisHeaderCell';
        const columnsAxisItem = columnsAxisItems[i];
        this.#setCellItemId(tableCell, columnsAxisItem, i);
        labelText = QueryAxisItem.getCaptionForQueryAxisItem(columnsAxisItem);
        label = createEl('span', {
          "class": 'pivotTableUiCellLabel pivotTableUiAxisHeaderLabel'
        });
        label.title = labelText;
        label.textContent = labelText;
        columnWidth = labelText.length + 1;

        if (columnWidth > PivotTableUi.#maximumCellWidth) {
          columnWidth = PivotTableUi.#maximumCellWidth;
        }

        tableCell.style.width = columnWidth + 'ch';
        tableCell.appendChild(label);
      }
    }

    firstTableHeaderRow = tableHeaderDom.childNodes.item(0);
    let stufferCell;
    stufferCell = createEl('div', {
      "class": "pivotTableUiCell pivotTableUiHeaderCell pivotTableUiStufferCell",
      "role": "presentation"
    });
    firstTableHeaderRow.appendChild(stufferCell);

    const stufferRow = createEl('div', {
      "class": "pivotTableUiRow",
      "role": "row"
    });
    tableBodyDom.appendChild(stufferRow);
    stufferCell = createEl('div', {
      "class": "pivotTableUiCell pivotTableUiHeaderCell pivotTableUiStufferCell",
      "role": "presentation"
    });
    stufferRow.appendChild(stufferCell);
  }

  #renderColumns(tuples){

    const containerDom = this.#getInnerContainerDom();
    const innerContainerWidth = containerDom.clientWidth;
    const tableDom = this.#getTableDom();
    let _physicalColumnsAdded = 0;

    const queryModel = this.getQueryModel();
    const queryAxis = queryModel.getColumnsAxis();
    const queryAxisItems = queryAxis.getItems();
    const totalsItemsIndices = PivotTableUi.#getTotalsItemsIndices(queryAxisItems);

    const tupleValueFields = this.#columnsTupleSet.getTupleValueFields();

    let numCellHeaders = 0;
    const numTuples = tuples.length;
    let numColumns = numTuples;
    const cellHeadersPlacement = queryModel.getCellHeadersAxis();
    const renderCellHeaders = (cellHeadersPlacement === QueryModel.AXIS_COLUMNS);

    const cellsAxis = queryModel.getCellsAxis();
    const cellItems = cellsAxis.getItems();
    if (renderCellHeaders) {
      numCellHeaders = cellItems.length;
      if (numCellHeaders === 0) {
        numCellHeaders = 1;
      }
    }
    else {
      numCellHeaders = 1;
    }

    // if there are no tuples on the column axis, but there are items in the cells axis,
    // then we still need 1 column
    if (numColumns === 0 && cellItems.length) {
      numColumns = 1;
    }

    const tableHeaderDom = this.#getTableHeaderDom();
    const headerRows = tableHeaderDom.childNodes;
    const firstHeaderRow = headerRows.item(0);

    if (!firstHeaderRow) {
      return;
    }

    const firstHeaderRowCells = firstHeaderRow.childNodes;
    const stufferCell = firstHeaderRowCells.item(firstHeaderRowCells.length - 1);

    // loop for each row from the column axis query result
    // if there aren't any, but the cells are on the column axis, and there is at least one item on the cell axis, this will still run once.
    for (let i = 0; i < numColumns; i++){
      let tuple;
      if (i < numTuples){
        tuple = tuples[i];
      }

      let valuesMaxWidth = 0, columnWidth = 0;
      let values, groupingId;
      if (tuple){
        values = tuple.values;
        groupingId = tuple[TupleSet.groupingIdAlias];
      }

      for (let k = 0; k < numCellHeaders; k++){
        for (let j = 0; j < headerRows.length; j++){
          const queryAxisItem = queryAxisItems[j];
          const isTotalsMember = PivotTableUi.#isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : undefined);

          const headerRow = headerRows.item(j);

          const cell = createEl('div', {
            "class": "pivotTableUiCell pivotTableUiHeaderCell",
            "role": "columnheader",
            "data-totals": groupingId > 0
          });
          this.#setCellItemId(cell, queryAxisItem, j);

          if (j >= queryAxisItems.length && renderCellHeaders ){
            cell.className += ' pivotTableUiCellAxisHeaderCell';
            cell.setAttribute('data-axis', QueryModel.AXIS_CELLS);
          }

          let labelText = undefined;
          if (isTotalsMember > j){
            if (values && j < values.length) {
              if (k === 0) {
                const value = values[j];
                const tupleValueField = tupleValueFields[j];
                labelText = queryAxisItem.formatter ? queryAxisItem.formatter(value, tupleValueField) : String(value);
                this.#setCellValueLiteral(cell, queryAxisItem, value, tupleValueField);
              }
              else {
                labelText = String.fromCharCode(160);
              }

              if (labelText.length > valuesMaxWidth){
                valuesMaxWidth = labelText.length;
                columnWidth = valuesMaxWidth;
              }
            }
            else
            if (renderCellHeaders && k < cellItems.length) {
              const cellItem = cellItems[k];
              labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellItem);
              columnWidth = labelText.length > valuesMaxWidth ? labelText.length : valuesMaxWidth;
              this.#setCellItemId(cell, cellItem, k);
            }
          }
          else
          if (isTotalsMember === j) {
            labelText = this.#getTotalsString(queryAxisItem);
          }
          if (labelText === undefined) {
            labelText = String.fromCharCode(160);
          }

          const label = createEl('span', {
            "class": "pivotTableUiCellLabel"
          });
          label.title = labelText;
          label.textContent = labelText;

          cell.appendChild(label);

          if (j === 0){
            headerRow.insertBefore(cell, stufferCell);
          }
          else {
            headerRow.appendChild(cell);
          }

          if (j === headerRows.length - 1) {

            columnWidth += 1;
            if (columnWidth > PivotTableUi.#maximumCellWidth) {
              columnWidth = PivotTableUi.#maximumCellWidth;
            }

            stufferCell.previousSibling.style.width = columnWidth + 'ch';
          }
        }

        _physicalColumnsAdded += 1;
        //check if the table overshoots the allowable width
        if (tableDom.clientWidth > innerContainerWidth) {
          return;
        }
      }
    }
  }

  #removeExcessColumns(){
    const tableHeaderDom = this.#getTableHeaderDom();
    const headerRows = tableHeaderDom.childNodes;
    const firstHeaderRow = headerRows.item(0);
    if (!firstHeaderRow) {
      return;
    }
    const firstHeaderRowCells = firstHeaderRow.childNodes;
    const lastHeaderRowIndex = headerRows.length -1;

    const containerDom = this.#getInnerContainerDom();
    const innerContainerWidth = containerDom.clientWidth;
    const tableDom = this.#getTableDom();

    if (innerContainerWidth <= 0) {
      return;
    }
    while (tableDom.clientWidth > innerContainerWidth) {
      // table exceeds allowed width remove the last column.
      for (let j = lastHeaderRowIndex; j >=0; j--){
        const headerRow = headerRows.item(j);
        const cells = headerRow.childNodes;
        const lastCellIndex = firstHeaderRowCells.length - 2;
        if (lastCellIndex < 0 || lastCellIndex >= cells.length) {
          return;
        }
        const lastCell = cells.item(lastCellIndex);
        if (j === lastHeaderRowIndex && (tableDom.clientWidth - lastCell.clientWidth) < innerContainerWidth) {
          return;
        }
        headerRow.removeChild(lastCell);
      }
    }
  }

  #removeExcessRows(){
    const tableHeaderDom = this.#getTableHeaderDom();
    const _headerRows = tableHeaderDom.childNodes;

    const containerDom = this.#getInnerContainerDom();
    const innerContainerHeight = containerDom.clientHeight;
    const tableDom = this.#getTableDom();

    if (innerContainerHeight <= 0) {
      return;
    }
    const tableBodyDom = this.#getTableBodyDom();
    const tableBodyDomRows = tableBodyDom.childNodes;

    while (tableDom.clientHeight > innerContainerHeight && tableBodyDomRows.length > 1) {
      // the last row is the stuffer row, remove the row before that.
      const tableBodyRow = tableBodyDomRows[tableBodyDomRows.length - 2];
      tableBodyDom.removeChild(tableBodyRow);
    }
  }

  #renderRows(tuples){
    const containerDom = this.#getInnerContainerDom();
    const innerContainerHeight = containerDom.clientHeight;
    const tableDom = this.#getTableDom();
    let _physicalRowsAdded = 0;

    const queryModel = this.getQueryModel();
    const columnsAxis = queryModel.getColumnsAxis();
    const _columnAxisItems = columnsAxis.getItems();

    const rowsAxis = queryModel.getRowsAxis();
    const rowAxisItems = rowsAxis.getItems();
    let numColumns = rowAxisItems.length;
    let _itemId;

    const tupleValueFields = this.#rowsTupleSet.getTupleValueFields();

    let numCellHeaders = 1;
    let numRows = tuples.length;
    const cellHeadersPlacement = queryModel.getCellHeadersAxis();
    const renderCellHeaders = (cellHeadersPlacement === QueryModel.AXIS_ROWS);

    const cellsAxis = queryModel.getCellsAxis();
    const cellAxisItems = cellsAxis.getItems();

    if (renderCellHeaders) {
      numCellHeaders = cellAxisItems.length;
      if (numCellHeaders === 0) {
        numCellHeaders = 1;

        const columnsAxis = queryModel.getColumnsAxis();
        const columnAxisItems = columnsAxis.getItems();
        if (columnAxisItems.length){
          numColumns += 1;
        }
      }
      else {
        numColumns += 1;
      }
    }
    else
    if (numColumns === 0){
      numColumns = 1;
    }

    // if there are no tuples on the rows axis, but there are items in the cells axis,
    // then we still need 1 row
    if (numRows === 0 && cellAxisItems.length) {
      numRows = 1;
    }

    const tableHeaderDom = this.#getTableHeaderDom();
    const tableHeaderRows = tableHeaderDom.childNodes;
    const firstTableHeaderRow = tableHeaderRows.item(0);

    if (!firstTableHeaderRow){
      return;
    }
    const firstTableHeaderRowCells = firstTableHeaderRow.childNodes;

    const tableBodyDom = this.#getTableBodyDom();
    const tableBodyDomRows = tableBodyDom.childNodes;
    const stufferRow = tableBodyDomRows.item(0);

    for (let i = 0; i < numRows; i++){
      const tuple = tuples[i];
      const groupingId = tuple ? tuple[TupleSet.groupingIdAlias] : undefined;

      for (let k = 0; k < numCellHeaders; k++){
        const bodyRow = createEl('div', {
          "class": "pivotTableUiRow",
          "role": "row",
          "data-totals": groupingId > 0
        });

        tableBodyDom.insertBefore(bodyRow, stufferRow);

        for (let j = 0; j < numColumns; j++){
          const cell = createEl('div', {
            "class": "pivotTableUiCell pivotTableUiHeaderCell",
            "role": "rowheader"
          });

          const headerCell = firstTableHeaderRowCells.item(bodyRow.childNodes.length);
          let headerCellWidth = parseInt(headerCell && headerCell.style ? headerCell.style.width : '', 10);
          if (isNaN(headerCellWidth)) {
            headerCellWidth = 0;
          }

          bodyRow.appendChild(cell);

          let labelText = undefined;
          if (j < rowAxisItems.length) {
            if (k === 0 && tuple) {
              const value = tuple.values[j];
              const rowAxisItem = rowAxisItems[j];
              this.#setCellItemId(cell, rowAxisItem, j);

              const tupleValueField = tupleValueFields[j];
              labelText = rowAxisItem.formatter ? rowAxisItem.formatter(value, tupleValueField) : String(value);
              this.#setCellValueLiteral(cell, rowAxisItem, value, tupleValueField);

            }
          }
          else {
            cell.className += ' pivotTableUiCellAxisHeaderCell';
            if (k < cellAxisItems.length && renderCellHeaders) {
              const cellsAxisItem = cellAxisItems[k];
              labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
              this.#setCellItemId(cell, cellsAxisItem, k);
            }
          }

          if (!labelText || !labelText.length) {
            labelText = String.fromCharCode(160);
          }

          const label = createEl('span', {
            "class": "pivotTableUiCellLabel",
          });
          label.title = labelText;
          label.textContent = labelText;
          cell.appendChild(label);

          if (headerCellWidth < labelText.length){
            headerCellWidth = labelText.length + 1;

            if (headerCellWidth > PivotTableUi.#maximumCellWidth) {
              headerCellWidth = PivotTableUi.#maximumCellWidth;
            }

            if (headerCell) {
              headerCell.style.width = headerCellWidth + 'ch';
            }
            cell.style.width = headerCellWidth + 'ch';
          }
        }

        _physicalRowsAdded += 1;
        // check if the table overshoots its heigh.
        const newTableDomHeight = tableDom.clientHeight;
        if (newTableDomHeight > innerContainerHeight) {
          // remove the last added row to ensure it fits in the container
          // we need it to it or else the "sticky" positioning won't work as intended
          // TODO: mabe position the table explicitly to achieve the sticky effect so we don't need to remove the ultimate row/column
          //tableBodyDom.removeChild(bodyRow);
          return;
        }
      }
    }
  }

  #renderCells(){
    const _tableHeaderDom = this.#getTableHeaderDom();

    const columnAxisSizeInfo = this.#getColumnsAxisSizeInfo();
    if (!columnAxisSizeInfo) {
      return;
    }
    
    const columnOffset = columnAxisSizeInfo.headers.columnCount;
    const columnCount = columnAxisSizeInfo.headers.columnCount + columnAxisSizeInfo.columns.columnCount;

    const tableBodyDom = this.#getTableBodyDom();
    const tableBodyDomRows = tableBodyDom.childNodes;

    for (let i = 0; i < tableBodyDomRows.length - 1; i++){
      const bodyRow = tableBodyDomRows.item(i);
      for (let j = columnOffset; j < columnCount; j++){

        const cell = createEl('div', {
          "class": "pivotTableUiCell pivotTableUiValueCell",
          "role": "gridcell",
          "data-axis": QueryModel.AXIS_CELLS
        });
        bodyRow.appendChild(cell);
        const label = createEl('span', {
          "class": "pivotTableUiCellLabel"
        }, '');
        cell.appendChild(label);
      }
    }
  }

  #estimateColumnsAxisPageSize(){
    return 100;
  }

  #estimateRowsAxisPageSize(){
    return 100;
  }

  #getDittoMark(){
    return _getDittoMark(this.#settings);
  }

  #getHideRepeatingAxisValues(){
    return _getHideRepeatingAxisValues(this.#settings);
  }

  #getMaxCellWidth(){
    return _getMaxCellWidth(this.#settings);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async updatePivotTableUi(){
    if (this.#getBusy()) {
      return;
    }

    const maxCellWidth = this.#getMaxCellWidth();
    PivotTableUi.#maximumCellWidth = maxCellWidth;

    const tableDom = this.#getTableDom();
    try {

      const cellHeadersAxis = this.getQueryModel().getCellHeadersAxis();
      const currCellHeadersAxis = tableDom.getAttribute('data-cellheadersaxis');
      if (cellHeadersAxis !== currCellHeadersAxis) {
        tableDom.setAttribute('data-cellheadersaxis', cellHeadersAxis);
      }

      this.#setBusy(true);
      this.#setProgressMessage('Preparing pivot layout...');
      this.clear();

      const totalStart = performance.now();

      const columnsTupleSet = this.#columnsTupleSet;
      const rowsTupleSet = this.#rowsTupleSet;

      this.#renderHeader();

      tableDom.style.width = '';

      const pageSizes = await Promise.all([
        this.#estimateColumnsAxisPageSize(),
        this.#estimateRowsAxisPageSize(),
      ]);

      columnsTupleSet.setPageSize(pageSizes[0]);
      rowsTupleSet.setPageSize(pageSizes[1]);

      const renderAxisPromises = [
        columnsTupleSet.getTuples(columnsTupleSet.getPageSize(), 0),
        rowsTupleSet.getTuples(rowsTupleSet.getPageSize(), 0)
      ];

      this.#setProgressMessage('Loading row and column members...');
      const renderAxisPromisesResults = await Promise.all(renderAxisPromises);

      const queryTimeMs = Math.round(performance.now() - totalStart);
      const renderStart = performance.now();

      const columnTuples = renderAxisPromisesResults[0];
      this.#setHorizontalSize(0);
      this.#renderColumns(columnTuples);

      const rowTuples = renderAxisPromisesResults[1];
      this.#setVerticalSize(0);

      this.#renderRows(rowTuples);

      this.#updateVerticalSizer();
      this.#toggleObserveColumnsResizing(true);

      this.#setProgressMessage('Rendering visible cells...');
      this.#renderCells();

      this.#setProgressMessage('Fetching aggregated cell values...');
      await this.#updateDataToScrollPosition();

      const renderTimeMs = Math.round(performance.now() - renderStart);
      this.#lastMetrics = {
        queryTimeMs: queryTimeMs,
        renderTimeMs: renderTimeMs,
        totalTimeMs: Math.round(performance.now() - totalStart)
      };

      setTimeout(() =>{
        const columnsSizeInfo = this.#getColumnsAxisSizeInfo();
        if (!columnsSizeInfo) {
          return;
        }
        this.#removeExcessColumns();
        this.#updateHorizontalSizer();
        this.#removeExcessRows();
        this.#updateVerticalSizer();
      }, 1000)
      this.#setNeedsUpdate(false);
      this.#fireUpdatedSuccess();
    }
    catch(e){
      console.error(e);
      const eventData = {
        status: 'error',
        error: e
      };
      this.fireEvent('updated', eventData);
    }
    finally {
      tableDom.style.width = '99.99%';
      this.#setBusy(false);
    }
  }

  clear(){
    this.#toggleObserveColumnsResizing(false);
    const tableHeaderDom = this.#getTableHeaderDom();
    tableHeaderDom.replaceChildren();
    const tableBodyDom = this.#getTableBodyDom();
    tableBodyDom.replaceChildren();
    this.#setHorizontalSize(0);
    this.#setVerticalSize(0);
    this.#fireUpdatedSuccess();
  }

  getDom(){
    return document.getElementById(this.#id);
  }

  // ─── DOM Accessors ────────────────────────────────────────────────────────

  #getInnerContainerDom(){
    return getChildWithClassName(this.getDom(), 'pivotTableUiInnerContainer');
  }

  #getHorizontalSizer() {
    return getChildWithClassName(this.#getInnerContainerDom(), 'pivotTableUiHorizontalSizer');
  }

  #setHorizontalSize(size){
    const sizer = this.#getHorizontalSizer();
    sizer.style.width = size + 'px';
  }

  #getEffectiveTupleCountForAxis(axisId){
    let tupleSet;
    switch (axisId){
      case QueryModel.AXIS_COLUMNS:
        tupleSet = this.#columnsTupleSet;
        break;
      case QueryModel.AXIS_ROWS:
        tupleSet = this.#rowsTupleSet;
        break;
      default:
        throw new Error(`Invalid axis id ${axisId}.`);
    }

    const tupleCount = tupleSet.getTupleCountSync();
    if (tupleCount === undefined) {
      return 1;
    }

    if (tupleCount === 0) {
      const queryModel = this.getQueryModel();
      const axisItems = queryModel.getQueryAxis(axisId).getItems();
      const cellsAxisItems = queryModel.getCellsAxis().getItems();
      if (axisItems.length === 0 && queryModel.getCellHeadersAxis() === axisId && cellsAxisItems.length) {
        return 1;
      }
    }

    return tupleCount;
  }

  #getNumberOfPhysicalTuplesForAxis(axisId){
    const queryModel = this.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();

    let factor;
    if (cellHeadersAxis === axisId) {
      const cellsAxis = queryModel.getCellsAxis();
      const items = cellsAxis.getItems();
      factor = items.length;
    }

    if (!factor) {
      factor = 1;
    }
    const tupleCount = this.#getEffectiveTupleCountForAxis(axisId);
    const numberOfPhysicalRows = tupleCount * factor;
    return numberOfPhysicalRows;
  }

  #getColumnsAxisSizeInfo(){
    const tableHeaderDom = this.#getTableHeaderDom();
    const firstHeaderRow = tableHeaderDom.childNodes.item(0);

    if (!firstHeaderRow ){
      return undefined;
    }

    const cells = firstHeaderRow.childNodes;

    const queryModel = this.getQueryModel();
    const rowsAxis = queryModel.getQueryAxis(QueryModel.AXIS_ROWS);
    const rowsAxisItems = rowsAxis.getItems();

    const columnsAxis = queryModel.getQueryAxis(QueryModel.AXIS_COLUMNS);
    const _columnsAxisItems = columnsAxis.getItems();

    const cellsAxis = queryModel.getQueryAxis(QueryModel.AXIS_CELLS);
    const cellsAxisItems = cellsAxis.getItems();

    const cellHeadersAxis = queryModel.getCellHeadersAxis();

    let numHeaderItems;
    numHeaderItems = rowsAxisItems.length;
    if (cellHeadersAxis === QueryModel.AXIS_ROWS) {
      if (cellsAxisItems.length){
        numHeaderItems += 1;
      }
    }

    if (numHeaderItems === 0) {
      numHeaderItems = 1;
    }

     const sizeInfo = {
      headers: {
        width: 0,
        columnCount: numHeaderItems,
        numPhysicalHeaders: 0
      },
      columns: {
        width: 0,
        columnCount: 0
      }
    };

    // we have to subtract 1 for the stuffer cell.
    const numCells = cells.length - 1;
    for (let i = 0; i < numCells; i++){
      const cell = cells.item(i);
      if (i < numHeaderItems) {
        sizeInfo.headers.width += cell.clientWidth;
        sizeInfo.headers.numPhysicalHeaders += 1;
      }
      else {
        sizeInfo.columns.width += cell.clientWidth;
        sizeInfo.columns.columnCount += 1;
      }
    }

    return sizeInfo;
  }

  #updateHorizontalSizer(){
    const numberOfPhysicalTuples = this.#getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_COLUMNS);
    const sizeInfo = this.#getColumnsAxisSizeInfo();
    if (!sizeInfo) {
      console.warn('updateHorizontalSizer: no sizeInfo');
      return;
    }

    let avgColumnWidth;
    if (sizeInfo.columns.columnCount === 0) {
      avgColumnWidth = 0;
    }
    else {
      avgColumnWidth = sizeInfo.columns.width / sizeInfo.columns.columnCount;
    }
    const requiredWidth = avgColumnWidth * numberOfPhysicalTuples;

    let headersWidth;
    if (sizeInfo.headers.numPhysicalHeaders === sizeInfo.headers.columnCount) {
      // all headers are rendered, the headersWidth is the actual width;
      headersWidth = sizeInfo.headers.width;
    }
    else {
      const avgHeaderWidth = sizeInfo.headers.width / sizeInfo.headers.numPhysicalHeaders;
      headersWidth = avgHeaderWidth * sizeInfo.headers.columnCount;
    }

    const totalWidth = headersWidth + requiredWidth;
    this.#setHorizontalSize(totalWidth);
  }

  #getVerticalSizer() {
    return getChildWithClassName(this.#getInnerContainerDom(), 'pivotTableUiVerticalSizer');
  }

  #setVerticalSize(size){
    const sizer = this.#getVerticalSizer();
    sizer.style.height = size + 'px';
  }

  #getRowsAxisSizeInfo(){
    const tableHeaderDom = this.#getTableHeaderDom();
    const tableBodyDom = this.#getTableBodyDom();

    return {
      headers: {
        height: tableHeaderDom.clientHeight,
        rowCount: tableHeaderDom.childNodes.length
      },
      rows: {
        height: tableBodyDom.clientHeight,
        // we have to subtract 1 from the number of childnodes because we always have one empty row for the stuffer cell.
        rowCount: tableBodyDom.childNodes.length - 1
      }
    };
  }

  #updateVerticalSizer(){
    const numberOfPhysicalTuples = this.#getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_ROWS);
    const sizeInfo = this.#getRowsAxisSizeInfo();
    if (!sizeInfo) {
      console.warn('updateVerticalSizer: no sizeInfo');
      return;
    }
    const rowCount = sizeInfo.rows.rowCount;
    const physicalRowHeight = rowCount > 0 ? sizeInfo.rows.height / rowCount : 0;
    const requiredHeight = physicalRowHeight * numberOfPhysicalTuples;
    const totalHeight = sizeInfo.headers.height + requiredHeight;
    this.#setVerticalSize(totalHeight);
  }

  #getTableDom(){
    const innerContainerDom = this.#getInnerContainerDom();
    return getChildWithClassName(innerContainerDom, 'pivotTableUiTable');
  }

  #getTableHeaderDom(){
    const tableDom = this.#getTableDom();
    return getChildWithClassName(tableDom, 'pivotTableUiTableHeader');
  }

  #getTableBodyDom(){
    const tableDom = this.#getTableDom();
    return getChildWithClassName(tableDom, 'pivotTableUiTableBody');
  }

  // ─── Context Menu ─────────────────────────────────────────────────────────

  #contextMenuContext = null;
  beforeShowContextMenu(event, _contextMenu){
    const target = event.target;
    let cell = target;
    const dom = this.getDom();
    while (cell !== dom && cell && !hasClass(cell, 'pivotTableUiCell')){
      cell = cell.parentNode;
    }
    if (!cell || cell === dom) {
      return false;
    }
    this.#contextMenuContext = cell;
  }

  async contextMenuItemClicked(event){
    const target = event.target;
    const id = target.id;
    
    const suffix = id.slice('pivotTableContextMenuItem'.length);
    if (suffix.startsWith('Copy')){
      await this.#contextMenuCopyClicked(event);
    }
    else
    if (suffix.startsWith('Filter')){
      await this.#contextMenuFilterClicked(event);
    }
  }

  // see: https://github.com/rpbouman/huey/issues/543
  #contextMenuFilterClicked(event){
    const target = event.target;
    const id = target.id;

    const contextMenuContext = this.#contextMenuContext;
    this.#contextMenuContext = null;

    const axis = contextMenuContext.getAttribute('data-axis');
    switch(axis){
      case QueryModel.AXIS_COLUMNS:
      case QueryModel.AXIS_ROWS:
        break;
      default:
        showErrorDialog({
          title: `Invalid axis: ${axis}`,
          description: `Can not filter on items from the "${axis}" axis.`
        });
        return;
    }

    let filterType = FilterDialog.equalityFilterTypes.INCLUDE;
    switch(id){
      case 'pivotTableContextMenuItemFilterExcludeValue':
        filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
      case 'pivotTableContextMenuItemFilterIncludeValue':
        break;
      default:
        // we didn't expect This
        throw new Error(`Unrecognized context menu option "${id}"`);
    }

    const queryModel = this.#queryModel;
    const queryModelAxis = queryModel.getQueryAxis(axis);
    const axisItemIndex = contextMenuContext.getAttribute('data-axis-item-index');
    const queryModelItem = Object.assign({}, queryModelAxis.getItems()[parseInt(axisItemIndex, 10)]);
    
    const filterValue = contextMenuContext.textContent;
    const literal = contextMenuContext.getAttribute('data-value-literal');

    queryModelItem.axis = QueryModel.AXIS_FILTERS;
    let newFilter;
    const newFilterValues = {};
    const newFilterValueListValue = {
      value: filterValue, 
      label: filterValue, 
      literal: literal
    };
    let newFilterItem = queryModel.findItem(queryModelItem);
    if (newFilterItem){
      // this filter item already exists.
      const oldFilter = newFilterItem.filter;
      const oldFilterValues = oldFilter ? oldFilter.values : undefined;
      const oldFilterValueEntry = oldFilterValues ? oldFilterValues[filterValue] : undefined;
      const oldFilterValueEntryDisabled = oldFilterValueEntry ? oldFilterValueEntry.enabled === false : false;
      const numOldFilterValues = oldFilterValues ? Object.keys(oldFilterValues).length : 0;

      switch(filterType){
        case FilterDialog.equalityFilterTypes.INCLUDE:
          // if the user select to include the current value, it should be taken to mean to include *only* this value.
          // i.e. the existing filter for this item is replaced by a simple "in" filter, having only the chosen value.
          newFilterValues[filterValue] = newFilterValueListValue;
          newFilter = {
            filterType: filterType,
            values: newFilterValues
          }
          break;
        case FilterDialog.equalityFilterTypes.EXCLUDE:
          // Use chose "exclude". 
          // This probably means the existing filter item should be adjusted to exclude *also* this value
          // What this means exactly depends on the type of the existing filter item
          switch (oldFilter.filterType){
            case FilterDialog.equalityFilterTypes.INCLUDE:
              // The existing filter must either be empty, or already include the current value, else the user couldn't have chosen it
              // The action is to simply remove the current value from the value list of the existing Filter
              // BUT! if this leaves the list of values empty, then removing the current value will have the effect of not applying any restriction at all
              // so, in this (edge) case, we must change the filter from INCLUDE to EXCLUDE, and add the current value.
              if (numOldFilterValues === 0) {
                oldFilter.filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
                newFilter = oldFilter;
              }
              else 
              if (oldFilterValueEntry) {
                if (oldFilterValueEntryDisabled) {
                  // this shouldn't happen
                  throw new Error('Unexpected: old filter entry is disabled');
                }
                else
                if (numOldFilterValues === 1) {
                  // in this case, removing the value from the list would leave an empty list, which would not exclude the current value
                  // so, we change the filter type from INCLUDE to EXCLUDE instead.
                  oldFilter.filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
                  newFilter = oldFilter;
                }
                else {
                  // current value is in the inlcude list, so let's remove it:
                  delete oldFilterValues[filterValue];
                  newFilter = oldFilter;
                }
              }
              else {
                // this shouldn't happen
                throw new Error('Unexpected: old filter does not have an entry for the value');
              }
              break;
            case FilterDialog.equalityFilterTypes.EXCLUDE:
              // We should check the existing list to see if the current value is already in the list. 
              // If it is, then it must mean that current value is disabled, else the user could never have selected it. In this case we can simple enable it
              // If it is not, then we should simply add the current value to the list.
              if (oldFilterValueEntry) {
                if (oldFilterValueEntryDisabled){
                  delete oldFilterValueEntry['enabled'];
                  newFilter = oldFilter;
                }
                else {
                  throw new Error('Unexpected: old filter entry is not disabled');
                }
              }
              else {
                oldFilterValues[filterValue] = newFilterValueListValue;
                newFilter = oldFilter;
              }
              break;
            case FilterDialog.simplePatternFilterTypes.LIKE:
              // if the existing filter is of type like, and the list of values that satisfies the like contains more values than only the current value, 
              // then we have a problem, as we cannot modify this filter in a way that would exclude only the current value. 
              // In this case, we should probably prompt the user, either to inform them that their request can't be executed 
              // or to ask offer them alternative actions (we can park this for a future improvement and for now just refuse to satisfy the request)
              break;
            case FilterDialog.simplePatternFilterTypes.NOTLIKE:
              // if the existing filter is of type not like
              // This is somewhat (but not quite) like the "not in" case (above)
              // if none of the current patterns match the current value, we can simply add the current value as a new pattern
              // if there is a pattern that is exactly equal to the current value, and it is disabled, then we can enable it.
              // if there is a (disabled) pattern that matches the current value, then we cannot simply enable it 
              // as that would likely also exclude other values. 
              // So instead we should then just add the current value as new pattern.
              break;
            case FilterDialog.rangeFilterTypes.BETWEEN:
              // if the existing filter is of type between, 
              // then we can identify the ranges that includes the current value, and split them so they won't include the current value anymore.            
              break;
            case FilterDialog.rangeFilterTypes.NOTBETWEEN:
              // if the existing filter is of type not between, then we can simply add an entry from and to the current value
              break;
            case FilterDialog.arrayFilterTypes.HASANY:
              break;
            case FilterDialog.arrayFilterTypes.HASALL:
              break;
            case FilterDialog.arrayFilterTypes.NOTHASANY:
              break;
            case FilterDialog.arrayFilterTypes.NOTHASALL:
              break;
            default:
          }
          
          break;
        default:
          // can't happen
      }
      
      queryModel.setQueryAxisItemFilter(newFilterItem, newFilter);
    }
    else {
      // this is easy. The query does not yet include a filter for this item so we just add it.
      newFilterItem = queryModelItem;
      newFilterValues[filterValue] = newFilterValueListValue;
      
      newFilter = {
        filterType: filterType,
        values: newFilterValues
      }
      
      newFilterItem.filter = newFilter;
      queryModel.addItem(newFilterItem);
    }
  }

  async #contextMenuCopyClicked(event) {
    const target = event.target;
    const id = target.id;

    const contextMenuContext = this.#contextMenuContext;
    this.#contextMenuContext = null;

    if (id === 'pivotTableContextMenuItemCopyCell'){
      copyToClipboard(contextMenuContext.textContent, 'text/plain');
      return;
    }

    const exportSettings = this.#settings.getSettings('exportUi');
    exportSettings.exportType = 'exportDelimited';
    exportSettings.exportDelimitedCompression = {value: 'UNCOMPRESSED'};
    exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = true);

    exportSettings.exportDestinationClipboard = true;
    exportSettings.exportDestinationFile = false;

    let queryAxisItem, cellsAxisItem, filter, filterAxisItem, itemId;
    const queryModel = this.#queryModel;
    const datasource = queryModel.getDatasource();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();

    const queryModelState = queryModel.getState();
    const queryModelAxes = queryModelState.axes;
    let filterAxisItems = queryModelAxes[QueryModel.AXIS_FILTERS];
    const cellsAxisItems = queryModelAxes[QueryModel.AXIS_CELLS];
    const rowsAxisItems = queryModelAxes[QueryModel.AXIS_ROWS];
    const columnsAxisItems = queryModelAxes[QueryModel.AXIS_COLUMNS];

    const tableHeaderDom = this.#getTableHeaderDom();
    const tableHeaderRows = tableHeaderDom.childNodes;
    const tableBodyDom = this.#getTableBodyDom();
    const _tableBodyRows = tableBodyDom.childNodes;
    let tableHeaderRow, _tableBodyRow, cells;

    // calculate the number of row headers
    let numRowHeaders = rowsAxisItems ? rowsAxisItems.length : 0;
    let numColumnHeaders = columnsAxisItems ? columnsAxisItems.length : 0;
    if (cellsAxisItems && cellsAxisItems.length) {
      switch (cellHeadersAxis){
        case QueryModel.AXIS_COLUMNS:
          numColumnHeaders += 1;
          break;
        case QueryModel.AXIS_ROWS:
          numRowHeaders += 1;
          break;
      }
    }

    const busyDialog = byId('visualizationProgressDialog');
    busyDialog.showModal();
    switch (id){
      case 'pivotTableContextMenuItemCopyColumnTuples':
        delete queryModelAxes[QueryModel.AXIS_ROWS];
        delete queryModelAxes[QueryModel.AXIS_CELLS];
        break;
      case 'pivotTableContextMenuItemCopyRowTuples':
        delete queryModelAxes[QueryModel.AXIS_COLUMNS];
        delete queryModelAxes[QueryModel.AXIS_CELLS];
        break;
      case 'pivotTableContextMenuItemCopyTable':
        exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
        break;
      case 'pivotTableContextMenuItemCopyColumn': {
        // find the physical column index
        let columnIndex = 0;
        let cell = contextMenuContext;
        while (cell && cell.previousSibling) {
          columnIndex += 1;
          cell = cell.previousSibling;
        }

        if (columnIndex < rowsAxisItems.length) {
          // the column is in the range of the row headers, this is a simple axis query on 1 row axis item
          delete queryModelAxes[QueryModel.AXIS_COLUMNS];
          delete queryModelAxes[QueryModel.AXIS_CELLS];
          queryAxisItem = rowsAxisItems[columnIndex];
          queryModelAxes[QueryModel.AXIS_ROWS].length = 0;
          queryModelAxes[QueryModel.AXIS_ROWS].push(queryAxisItem);
        }
        else
        if (columnIndex < numRowHeaders){
          // the column is in the range of the row headers, but this is not a row axis item - it must be a cells axis header.

        }
        else {
          exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
          // the column is a table column;
          // to export it, we set up a transformed query model that applies a filter to select only this column.
          if (!filterAxisItems){
            queryModelAxes[QueryModel.AXIS_FILTERS] = filterAxisItems = [];
          }

          for (let i = 0; i < tableHeaderRows.length; i++){
            tableHeaderRow = tableHeaderRows.item(i);
            cells = tableHeaderRow.childNodes;
            cell = cells.item(columnIndex);
            if (columnsAxisItems && i < columnsAxisItems.length){
              queryAxisItem = columnsAxisItems[i];
              itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
              filterAxisItem = filterAxisItems.find((filterAxisItem) =>{
                const id = QueryAxisItem.getIdForQueryAxisItem(filterAxisItem);
                return id === itemId;
              });
              if (filterAxisItem){
                filter = filterAxisItem.filter;
              }
              else{
                filterAxisItem = Object.assign({}, queryAxisItem);
                filter = filterAxisItem.filter = {};
                filterAxisItems.push(filterAxisItem);
              }
              filter.filterType = FilterDialog.filterTypes.INCLUDE;
              filter.values = {};
              filter.values[cell.textContent] = {
                value: cell.textContent,
                label: cell.textContent,
                literal: cell.getAttribute('data-value-literal')
              };
            }
            else
            if (cellHeadersAxis === QueryModel.AXIS_COLUMNS){
              itemId = cell.getAttribute('data-axis-item');
              cellsAxisItem = cellsAxisItems.find((cellsAxisItem) =>{
                const id = QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem);
                return id === itemId;
              });
              cellsAxisItems.length = 0;
              cellsAxisItems.push(cellsAxisItem);
            }
          }
        }
        break;
      }
      case 'pivotTableContextMenuItemCopyRow': {

        // find the physical row index
        let row = contextMenuContext.parentNode;
        let rowIndex = 0;
        while (row && row.previousSibling) {
          rowIndex += 1;
          row = row.previousSibling;
        }

        row = contextMenuContext.parentNode;
        if (row.parentNode === tableHeaderDom) {
          if (columnsAxisItems && rowIndex < columnsAxisItems.length){
            // this is a simple axis query on 1 column axis item.
            delete queryModelAxes[QueryModel.AXIS_ROWS];
            delete queryModelAxes[QueryModel.AXIS_CELLS];
            queryAxisItem = columnsAxisItems[rowIndex];
            queryModelAxes[QueryModel.AXIS_COLUMNS].length = 0;
            queryModelAxes[QueryModel.AXIS_COLUMNS].push(queryAxisItem);

          }
          else
          if (rowIndex < numColumnHeaders) {
            // this must be the cells header
          }
        }
        else
        if (row.parentNode === tableBodyDom){
          const cells = row.childNodes;
          exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
          // the column is a table column;
          // to export it, we set up a transformed query model that applies a filter to select only this column.
          if (!filterAxisItems){
            queryModelAxes[QueryModel.AXIS_FILTERS] = filterAxisItems = [];
          }

          let cell;
          for (let i = 0; i < numRowHeaders; i++){
            cell = cells.item(i);
            if (i < rowsAxisItems.length){
              queryAxisItem = rowsAxisItems[i];
              itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
              filterAxisItem = filterAxisItems.find((filterAxisItem) =>{
                const id = QueryAxisItem.getIdForQueryAxisItem(filterAxisItem);
                return id === itemId;
              });
              if (filterAxisItem){
                filter = filterAxisItem.filter;
              }
              else{
                filterAxisItem = Object.assign({}, queryAxisItem);
                filter = filterAxisItem.filter = {};
                filterAxisItems.push(filterAxisItem);
              }
              filter.filterType = FilterDialog.filterTypes.INCLUDE;
              filter.values = {};
              filter.values[cell.textContent] = {
                value: cell.textContent,
                label: cell.textContent,
                literal: cell.getAttribute('data-value-literal')
              };
            }
            else
            if (cellHeadersAxis === QueryModel.AXIS_ROWS){
              itemId = cell.getAttribute('data-axis-item');
              cellsAxisItem = cellsAxisItems.find((cellsAxisItem) =>{
                const id = QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem);
                return id === itemId;
              });
              cellsAxisItems.length = 0;
              cellsAxisItems.push(cellsAxisItem);
            }
          }
        }
        else {
        }
        break;
      }
      default:
        // we didn't expect This
        throw new Error(`Unrecognized context menu option "${id}"`);
    }

    try {
      const exportQueryModel = new QueryModel();

      // https://github.com/rpbouman/huey/issues/584
      // currently not all datasources are cleanly restored from state
      // in particular, on the fly datasources form a list of files.
      // while we figure out a better solution, we now simply reuse the existing datasource.
      const datasourceId = queryModelState.datasourceId;
      const parts = DuckDbDataSource.parseId(datasourceId);
      if (parts.type === DuckDbDataSource.types.FILES){
        delete queryModelState.datasourceId;
        exportQueryModel.setDatasource(datasource);
      }
      await exportQueryModel.setState(queryModelState);      
      await ExportUi.exportDataForQueryModel(exportQueryModel, exportSettings);
    }
    catch(error) {
      showErrorDialog(error);
    }
    finally {
      busyDialog.close();
    }
  }
}

export let pivotTableUi;
export let pivotTableUiHighlighting;
export function initPivotTableUi(){
  pivotTableUi = new PivotTableUi({
    container: 'workarea',
    id: 'pivotTableUi',
    queryModel: queryModel,
    settings: settings
  });

  const _pivotTableUiContextMenu = new ContextMenu(pivotTableUi, 'pivotTableContextMenu');
  
  pivotTableUiHighlighting = new PivotTableUiHighlighting(pivotTableUi);
  
  function updateAppearance(){
    const pivotTableSettings = settings.getSettings('pivotSettings');
    pivotTableUiHighlighting.enableAlternatingRowColors(pivotTableSettings.alternatingRowColors);
    pivotTableUiHighlighting.enableHoverRowHighlighting(pivotTableSettings.hoverRowHighlight);
    pivotTableUiHighlighting.enableHoverColumnHighlighting(pivotTableSettings.hoverColumnHighlight);
  }
  updateAppearance();
  settings.addEventListener('change', () =>{
    updateAppearance();
  });
}
